using System.Diagnostics;
using MongoDB.Bson;
using MongoDB.Driver;

namespace ZawMongo;

/// <summary>What one statement returned: documents, a value, or a message.</summary>
public sealed class ShellResult
{
    public int Statement { get; set; }
    public string Text { get; set; } = "";
    /// <summary>"docs" (Docs), "value" (Value) or "text" (Message only).</summary>
    public string Kind { get; set; } = "text";
    public string? Db { get; set; }
    public string? Collection { get; set; }
    public List<BsonJson>? Docs { get; set; }
    public bool Truncated { get; set; }
    /// <summary>The documents are whole documents of <see cref="Collection"/> with their _id: they can be edited.</summary>
    public bool Editable { get; set; }
    public BsonJson? Value { get; set; }
    public string? Message { get; set; }
    /// <summary>An explain() result: the UI shows it as a plan.</summary>
    public bool Explain { get; set; }
    public double Ms { get; set; }
}

/// <summary>Runs parsed shell statements (<see cref="Shell"/>) on a session.</summary>
public sealed class ShellRunner(DbSession session, OpLog log, int maxDocs, CancellationToken ct)
{
    /// <summary>The database "db" stands for; "use x" changes it.</summary>
    public string Database { get; set; } = "test";

    static BsonJson J(BsonValue v) => new(v);
    static List<BsonJson> Js(IEnumerable<BsonDocument> docs) => docs.Select(d => new BsonJson(d)).ToList();

    /// <summary>The statement as logged: runnable in mongosh, with the database it ran in spelled out.</summary>
    string LogText(ShellCommand c) => c.Kind is ShellKind.Use or ShellKind.Show || c.Database != null || !c.Text.StartsWith("db.", StringComparison.Ordinal)
        ? c.Text
        : $"db.getSiblingDB({Shell.Quote(Database)}){c.Text[2..]}";

    public async Task<ShellResult> RunAsync(ShellCommand c)
    {
        if (session.Profile.ReadOnly && ReadOnlyGuard.Check(c) is { } rejected)
            throw new ApiException($"Read-only session: {rejected}");
        var sw = Stopwatch.StartNew();
        var line = log.Add(LogText(c));
        try
        {
            var r = c.Kind switch
            {
                ShellKind.Use => Use(c),
                ShellKind.Show => await ShowAsync(c),
                ShellKind.Db => await DbMethodAsync(c),
                _ => await CollectionMethodAsync(c),
            };
            r.Text = c.Text;
            r.Ms = sw.Elapsed.TotalMilliseconds;
            return r;
        }
        finally { log.Finish(line); }
    }

    ShellResult Use(ShellCommand c)
    {
        var name = c.Arg ?? "";
        if (name.Length == 0 || name.IndexOfAny(['/', '\\', '.', ' ', '"', '$', '\0']) >= 0) throw new ApiException($"Invalid database name: {name}");
        Database = name;
        return new ShellResult { Kind = "text", Message = $"switched to db {name}", Db = name };
    }

    IMongoDatabase Db(ShellCommand c) => session.Db(c.Database ?? Database);
    string DbName(ShellCommand c) => c.Database ?? Database;

    async Task<BsonDocument> Command(IMongoDatabase db, BsonDocument cmd) =>
        await db.RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct);

    async Task<BsonDocument> Admin(BsonDocument cmd) => await Command(session.Db("admin"), cmd);

    /// <summary>A command reply: its cursor's documents when it has one, else the reply itself.</summary>
    ShellResult Reply(BsonDocument reply, string db)
    {
        if (reply.TryGetValue("cursor", out var cur) && cur is BsonDocument cd && cd.TryGetValue("firstBatch", out var fb) && fb is BsonArray batch)
        {
            var docs = batch.OfType<BsonDocument>().Take(maxDocs).ToList();
            return new ShellResult { Kind = "docs", Db = db, Docs = Js(docs), Truncated = batch.Count > maxDocs || cd.GetValue("id", 0L).ToInt64() != 0 };
        }
        return new ShellResult { Kind = "value", Db = db, Value = J(reply) };
    }

    async Task<(List<BsonDocument> Docs, bool Truncated)> Take(IAsyncCursor<BsonDocument> cursor, int max)
    {
        var list = new List<BsonDocument>();
        using (cursor)
        {
            while (await cursor.MoveNextAsync(ct))
            {
                foreach (var d in cursor.Current)
                {
                    if (list.Count >= max) return (list, true);
                    list.Add(d);
                }
            }
        }
        return (list, false);
    }

    // ---------------------------------------------------------------- show

    async Task<ShellResult> ShowAsync(ShellCommand c)
    {
        switch (c.Method)
        {
            case "dbs" or "databases":
            {
                var r = await Admin(new BsonDocument { { "listDatabases", 1 }, { "nameOnly", false } });
                var dbs = r["databases"].AsBsonArray.OfType<BsonDocument>().OrderBy(d => d["name"].AsString, StringComparer.Ordinal).ToList();
                return new ShellResult { Kind = "docs", Docs = Js(dbs), Message = $"{dbs.Count} databases" };
            }
            case "collections" or "tables":
            {
                var names = (await (await Db(c).ListCollectionNamesAsync(cancellationToken: ct)).ToListAsync(ct)).OrderBy(n => n, StringComparer.Ordinal).ToList();
                return new ShellResult { Kind = "docs", Db = DbName(c), Docs = Js(names.Select(n => new BsonDocument("name", n))), Message = $"{names.Count} collections" };
            }
            case "users":
                return Reply(await Command(Db(c), new BsonDocument("usersInfo", 1)), DbName(c)) is var u && u.Value?.Value is BsonDocument ud && ud.TryGetValue("users", out var ul)
                    ? new ShellResult { Kind = "docs", Db = DbName(c), Docs = Js(ul.AsBsonArray.OfType<BsonDocument>()) } : u;
            case "roles":
            {
                var r = await Command(Db(c), new BsonDocument { { "rolesInfo", 1 }, { "showBuiltinRoles", true } });
                return new ShellResult { Kind = "docs", Db = DbName(c), Docs = Js(r["roles"].AsBsonArray.OfType<BsonDocument>()) };
            }
            case "profile":
            {
                var cur = await Db(c).GetCollection<BsonDocument>("system.profile").Find(FilterDefinition<BsonDocument>.Empty)
                    .Sort(new BsonDocument("ts", -1)).Limit(5).ToCursorAsync(ct);
                var (docs, _) = await Take(cur, 5);
                return new ShellResult { Kind = "docs", Db = DbName(c), Collection = "system.profile", Docs = Js(docs), Message = docs.Count == 0 ? "No profiling data; turn it on with db.setProfilingLevel(1)." : null };
            }
            case "log":
            {
                var r = await Admin(new BsonDocument("getLog", c.Arg ?? "global"));
                var lines = r.GetValue("log", new BsonArray()).AsBsonArray.Select(l => l.ToString()).ToList();
                return new ShellResult { Kind = "value", Value = J(new BsonArray(lines)), Message = $"{lines.Count} lines" };
            }
            default:
                throw new ApiException($"Unknown: show {c.Method}. Try show dbs, collections, users, roles, profile or log.");
        }
    }

    // ---------------------------------------------------------------- db.method()

    async Task<ShellResult> DbMethodAsync(ShellCommand c)
    {
        var db = Db(c);
        var name = DbName(c);
        BsonDocument CmdArg(int i)
        {
            return c.ArgAt(i) switch
            {
                BsonDocument d => d,
                BsonString s => new BsonDocument(s.Value, 1),
                _ => throw new ApiException($"db.{c.Method}() needs a command document, such as {{ ping: 1 }}."),
            };
        }
        switch (c.Method)
        {
            case "runCommand":
            {
                var cmd = CmdArg(0);
                if (session.Profile.ReadOnly && ReadOnlyGuard.CheckCommand(cmd) is { } rej) throw new ApiException($"Read-only session: {rej}");
                return Reply(await Command(db, cmd), name);
            }
            case "adminCommand":
            {
                var cmd = CmdArg(0);
                if (session.Profile.ReadOnly && ReadOnlyGuard.CheckCommand(cmd) is { } rej) throw new ApiException($"Read-only session: {rej}");
                return Reply(await Admin(cmd), "admin");
            }
            case "getCollectionNames":
            {
                var names = (await (await db.ListCollectionNamesAsync(cancellationToken: ct)).ToListAsync(ct)).OrderBy(n => n, StringComparer.Ordinal);
                return new ShellResult { Kind = "value", Db = name, Value = J(new BsonArray(names)) };
            }
            case "getCollectionInfos":
            {
                var opts = new ListCollectionsOptions { Filter = c.DocAt(0, "filter") is { } f ? new BsonDocumentFilterDefinition<BsonDocument>(f) : null };
                var list = await (await db.ListCollectionsAsync(opts, ct)).ToListAsync(ct);
                return new ShellResult { Kind = "docs", Db = name, Docs = Js(list) };
            }
            case "stats":
            {
                var cmd = new BsonDocument("dbStats", 1);
                if (c.ArgAt(0) is { IsNumeric: true } scale) cmd["scale"] = scale;
                else if (c.ArgAt(0) is BsonDocument o) cmd.AddRange(o);
                return Reply(await Command(db, cmd), name);
            }
            case "createCollection":
            {
                var coll = c.ArgAt(0) is BsonString s ? s.Value : throw new ApiException("db.createCollection() takes a name.");
                var cmd = new BsonDocument("create", coll);
                if (c.DocAt(1, "options") is { } o) cmd.AddRange(o);
                return Reply(await Command(db, cmd), name);
            }
            case "createView":
            {
                if (c.ArgAt(0) is not BsonString view || c.ArgAt(1) is not BsonString source || c.ArgAt(2) is not BsonArray pipeline)
                    throw new ApiException("db.createView(name, source, [pipeline]) takes a name, a source collection and a pipeline.");
                var cmd = new BsonDocument { { "create", view }, { "viewOn", source }, { "pipeline", pipeline } };
                if (c.DocAt(3, "options") is { } o) cmd.AddRange(o);
                return Reply(await Command(db, cmd), name);
            }
            case "dropDatabase":
                return Reply(await Command(db, new BsonDocument("dropDatabase", 1)), name);
            case "getName":
                return new ShellResult { Kind = "value", Db = name, Value = J(name) };
            case "version":
                return new ShellResult { Kind = "value", Value = J((await Admin(new BsonDocument("buildInfo", 1)))["version"]) };
            case "serverBuildInfo":
                return Reply(await Admin(new BsonDocument("buildInfo", 1)), "admin");
            case "serverStatus":
                return Reply(await Admin(new BsonDocument("serverStatus", 1)), "admin");
            case "hostInfo":
                return Reply(await Admin(new BsonDocument("hostInfo", 1)), "admin");
            case "hello" or "isMaster":
                return Reply(await Admin(new BsonDocument("hello", 1)), "admin");
            case "listCommands":
                return Reply(await Admin(new BsonDocument("listCommands", 1)), "admin");
            case "currentOp":
            {
                var cmd = new BsonDocument("currentOp", 1);
                if (c.ArgAt(0) is BsonDocument f) cmd.AddRange(f);
                else if (c.ArgAt(0) is BsonBoolean { Value: true }) cmd["$all"] = true;
                var r = await Admin(cmd);
                return new ShellResult { Kind = "docs", Db = "admin", Docs = Js(r.GetValue("inprog", new BsonArray()).AsBsonArray.OfType<BsonDocument>()) };
            }
            case "killOp":
                return Reply(await Admin(new BsonDocument { { "killOp", 1 }, { "op", c.ArgAt(0) ?? throw new ApiException("db.killOp() takes an opid.") } }), "admin");
            case "getUsers":
            {
                var r = await Command(db, new BsonDocument("usersInfo", 1));
                return new ShellResult { Kind = "docs", Db = name, Docs = Js(r["users"].AsBsonArray.OfType<BsonDocument>()) };
            }
            case "getUser":
            {
                var r = await Command(db, new BsonDocument("usersInfo", c.ArgAt(0) ?? throw new ApiException("db.getUser() takes a user name.")));
                return new ShellResult { Kind = "docs", Db = name, Docs = Js(r["users"].AsBsonArray.OfType<BsonDocument>()) };
            }
            case "createUser":
            {
                var d = c.DocAt(0, "user") ?? throw new ApiException("db.createUser({ user, pwd, roles }) takes a user document.");
                var cmd = new BsonDocument("createUser", d.GetValue("user", "").ToString());
                foreach (var e in d.Elements.Where(e => e.Name != "user")) cmd[e.Name] = e.Value;
                if (!cmd.Contains("roles")) cmd["roles"] = new BsonArray();
                return Reply(await Command(db, cmd), name);
            }
            case "updateUser":
            {
                var cmd = new BsonDocument("updateUser", c.ArgAt(0) ?? throw new ApiException("db.updateUser(name, { … })"));
                if (c.DocAt(1, "update") is { } u) cmd.AddRange(u);
                return Reply(await Command(db, cmd), name);
            }
            case "dropUser":
                return Reply(await Command(db, new BsonDocument("dropUser", c.ArgAt(0) ?? throw new ApiException("db.dropUser() takes a user name."))), name);
            case "grantRolesToUser" or "revokeRolesFromUser":
                return Reply(await Command(db, new BsonDocument { { c.Method, c.ArgAt(0) ?? BsonNull.Value }, { "roles", c.ArgAt(1) ?? new BsonArray() } }), name);
            case "getRoles":
            {
                var cmd = new BsonDocument("rolesInfo", 1);
                if (c.ArgAt(0) is BsonDocument o) cmd.AddRange(o);
                var r = await Command(db, cmd);
                return new ShellResult { Kind = "docs", Db = name, Docs = Js(r["roles"].AsBsonArray.OfType<BsonDocument>()) };
            }
            case "getRole":
            {
                var cmd = new BsonDocument("rolesInfo", c.ArgAt(0) ?? throw new ApiException("db.getRole() takes a role name."));
                if (c.ArgAt(1) is BsonDocument o) cmd.AddRange(o);
                var r = await Command(db, cmd);
                return new ShellResult { Kind = "docs", Db = name, Docs = Js(r["roles"].AsBsonArray.OfType<BsonDocument>()) };
            }
            case "aggregate":
            {
                if (c.ArgAt(0) is not BsonArray stages) throw new ApiException("db.aggregate() takes a pipeline: [ { $currentOp: {} }, … ].");
                var cur = await db.AggregateAsync(PipelineDefinition<NoPipelineInput, BsonDocument>.Create(stages.OfType<BsonDocument>()), AggOptions(c.DocAt(1, "options")), ct);
                var (docs, more) = await Take(cur, maxDocs);
                return new ShellResult { Kind = "docs", Db = name, Docs = Js(docs), Truncated = more };
            }
            case "getProfilingStatus":
                return Reply(await Command(db, new BsonDocument("profile", -1)), name);
            case "setProfilingLevel":
            {
                var cmd = new BsonDocument("profile", c.ArgAt(0) ?? throw new ApiException("db.setProfilingLevel(level) takes 0, 1 or 2."));
                if (c.ArgAt(1) is BsonDocument o) cmd.AddRange(o);
                else if (c.ArgAt(1) is { IsNumeric: true } ms) cmd["slowms"] = ms;
                return Reply(await Command(db, cmd), name);
            }
            default:
                throw new ApiException($"db.{c.Method}() is not supported.");
        }
    }

    // ---------------------------------------------------------------- db.coll.method()

    static AggregateOptions AggOptions(BsonDocument? o)
    {
        var a = new AggregateOptions();
        if (o == null) return a;
        foreach (var e in o.Elements)
        {
            switch (e.Name)
            {
                case "allowDiskUse": a.AllowDiskUse = e.Value.ToBoolean(); break;
                case "maxTimeMS": a.MaxTime = TimeSpan.FromMilliseconds(e.Value.ToDouble()); break;
                case "batchSize": a.BatchSize = e.Value.ToInt32(); break;
                case "comment": a.Comment = e.Value; break;
                case "collation": a.Collation = Collation.FromBsonDocument(e.Value.AsBsonDocument); break;
                case "hint": a.Hint = e.Value; break;
                case "let": a.Let = e.Value.AsBsonDocument; break;
                default: throw new ApiException($"Unknown aggregate option: {e.Name}");
            }
        }
        return a;
    }

    static FilterDefinition<BsonDocument> Filter(BsonDocument? d) => d == null ? FilterDefinition<BsonDocument>.Empty : new BsonDocumentFilterDefinition<BsonDocument>(d);

    static UpdateDefinition<BsonDocument> Update(BsonValue? u) => u switch
    {
        BsonDocument d => new BsonDocumentUpdateDefinition<BsonDocument>(d),
        BsonArray a => new PipelineUpdateDefinition<BsonDocument>(PipelineDefinition<BsonDocument, BsonDocument>.Create(a.OfType<BsonDocument>())),
        _ => throw new ApiException("The update must be a document ({ $set: … }) or a pipeline ([ { $set: … } ])."),
    };

    async Task<ShellResult> CollectionMethodAsync(ShellCommand c)
    {
        var dbName = DbName(c);
        var coll = session.Coll(dbName, c.Collection!);
        if (c.Explain != null) return await ExplainAsync(c, c.Explain);
        if (c.Find("explain") is { } ex) return await ExplainAsync(c, Shell.Verbosity(ex.Args));
        ShellResult Value(BsonValue v, string? msg = null) => new() { Kind = "value", Db = dbName, Collection = c.Collection, Value = J(v), Message = msg };

        switch (c.Method)
        {
            case "find":
                return await FindAsync(c, coll);
            case "findOne":
            {
                var projection = c.DocAt(1, "projection");
                var doc = await coll.Find(Filter(c.DocAt(0, "filter"))).Project<BsonDocument>(projection ?? new BsonDocument()).Limit(1).FirstOrDefaultAsync(ct);
                if (doc == null) return Value(BsonNull.Value, "No document matched.");
                return new ShellResult { Kind = "docs", Db = dbName, Collection = c.Collection, Docs = [J(doc)], Editable = projection == null && doc.Contains("_id") };
            }
            case "aggregate":
            {
                if (c.ArgAt(0) is not BsonArray stages) throw new ApiException("aggregate() takes a pipeline: [ { $match: … }, … ].");
                var cur = await coll.AggregateAsync(PipelineDefinition<BsonDocument, BsonDocument>.Create(stages.OfType<BsonDocument>()), AggOptions(c.DocAt(1, "options")), ct);
                var (docs, more) = await Take(cur, maxDocs);
                return new ShellResult { Kind = "docs", Db = dbName, Collection = c.Collection, Docs = Js(docs), Truncated = more };
            }
            case "countDocuments" or "count":
            {
                var o = c.DocAt(1, "options");
                var opts = new CountOptions
                {
                    Limit = o?.GetValue("limit", BsonNull.Value) is { IsNumeric: true } l ? l.ToInt64() : null,
                    Skip = o?.GetValue("skip", BsonNull.Value) is { IsNumeric: true } s ? s.ToInt64() : null,
                    Hint = o?.GetValue("hint", BsonNull.Value) is { IsBsonNull: false } h ? h : null,
                    MaxTime = o?.GetValue("maxTimeMS", BsonNull.Value) is { IsNumeric: true } m ? TimeSpan.FromMilliseconds(m.ToDouble()) : null,
                };
                return Value(await coll.CountDocumentsAsync(Filter(c.DocAt(0, "filter")), opts, ct));
            }
            case "estimatedDocumentCount":
                return Value(await coll.EstimatedDocumentCountAsync(cancellationToken: ct));
            case "distinct":
            {
                var field = c.ArgAt(0) is BsonString f ? f.Value : throw new ApiException("distinct() takes a field name.");
                var cur = await coll.DistinctAsync<BsonValue>(field, Filter(c.DocAt(1, "filter")), cancellationToken: ct);
                var list = await cur.ToListAsync(ct);
                return Value(new BsonArray(list), $"{list.Count} distinct values");
            }
            case "insertOne":
            {
                var doc = c.DocAt(0, "document") ?? throw new ApiException("insertOne() takes a document.");
                await coll.InsertOneAsync(doc, cancellationToken: ct);
                return Value(new BsonDocument { { "acknowledged", true }, { "insertedId", doc["_id"] } }, "1 document inserted");
            }
            case "insertMany" or "insert":
            {
                var docs = c.ArgAt(0) switch
                {
                    BsonArray a when a.All(x => x is BsonDocument) => a.Select(x => x.AsBsonDocument).ToList(),
                    BsonDocument d when c.Method == "insert" => [d],
                    _ => throw new ApiException($"{c.Method}() takes an array of documents."),
                };
                if (docs.Count == 0) throw new ApiException("No documents to insert.");
                var ordered = c.DocAt(1, "options")?.GetValue("ordered", true).ToBoolean() ?? true;
                await coll.InsertManyAsync(docs, new InsertManyOptions { IsOrdered = ordered }, ct);
                return Value(new BsonDocument { { "acknowledged", true }, { "insertedIds", new BsonArray(docs.Select(d => d["_id"])) } }, $"{docs.Count} document{(docs.Count == 1 ? "" : "s")} inserted");
            }
            case "updateOne" or "updateMany" or "update":
            {
                var o = c.DocAt(2, "options");
                var opts = new UpdateOptions { IsUpsert = o?.GetValue("upsert", false).ToBoolean() ?? false };
                if (o?.GetValue("arrayFilters", BsonNull.Value) is BsonArray af) opts.ArrayFilters = af.OfType<BsonDocument>().Select(x => (ArrayFilterDefinition)new BsonDocumentArrayFilterDefinition<BsonDocument>(x));
                if (o?.GetValue("hint", BsonNull.Value) is { IsBsonNull: false } hint) opts.Hint = hint;
                if (o?.GetValue("collation", BsonNull.Value) is BsonDocument col) opts.Collation = Collation.FromBsonDocument(col);
                var many = c.Method == "updateMany" || (c.Method == "update" && (o?.GetValue("multi", false).ToBoolean() ?? false));
                var filter = Filter(c.DocAt(0, "filter") ?? throw new ApiException($"{c.Method}() needs a filter; {{}} matches every document."));
                var r = many ? await coll.UpdateManyAsync(filter, Update(c.ArgAt(1)), opts, ct) : await coll.UpdateOneAsync(filter, Update(c.ArgAt(1)), opts, ct);
                return Value(UpdateReply(r), $"{r.MatchedCount} matched, {r.ModifiedCount} modified{(r.UpsertedId != null ? ", 1 upserted" : "")}");
            }
            case "replaceOne":
            {
                var filter = Filter(c.DocAt(0, "filter") ?? throw new ApiException("replaceOne() needs a filter."));
                var doc = c.DocAt(1, "replacement") ?? throw new ApiException("replaceOne() needs the new document.");
                var r = await coll.ReplaceOneAsync(filter, doc, new ReplaceOptions { IsUpsert = c.DocAt(2, "options")?.GetValue("upsert", false).ToBoolean() ?? false }, ct);
                return Value(UpdateReply(r), $"{r.MatchedCount} matched, {r.ModifiedCount} modified{(r.UpsertedId != null ? ", 1 upserted" : "")}");
            }
            case "deleteOne" or "deleteMany" or "remove":
            {
                var filter = Filter(c.DocAt(0, "filter") ?? throw new ApiException($"{c.Method}() needs a filter; {{}} matches every document."));
                var one = c.Method == "deleteOne" || (c.Method == "remove" && c.ArgAt(1) is { } j && (j is BsonBoolean { Value: true } || (j is BsonDocument jd && jd.GetValue("justOne", false).ToBoolean())));
                var r = one ? await coll.DeleteOneAsync(filter, ct) : await coll.DeleteManyAsync(filter, ct);
                return Value(new BsonDocument { { "acknowledged", true }, { "deletedCount", r.DeletedCount } }, $"{r.DeletedCount} document{(r.DeletedCount == 1 ? "" : "s")} deleted");
            }
            case "findOneAndUpdate" or "findOneAndReplace" or "findOneAndDelete":
                return await FindOneAndAsync(c, coll);
            case "createIndex" or "createIndexes" or "ensureIndex":
            {
                var specs = c.Method == "createIndexes"
                    ? (c.ArgAt(0) as BsonArray ?? throw new ApiException("createIndexes() takes an array of key documents.")).Select(k => k as BsonDocument ?? throw new ApiException("Index keys must be documents.")).ToList()
                    : [c.DocAt(0, "keys") ?? throw new ApiException("createIndex() takes the keys: { field: 1 }.")];
                var common = c.DocAt(1, "options");
                var indexes = new BsonArray(specs.Select(k =>
                {
                    var spec = new BsonDocument { { "key", k }, { "name", common?.GetValue("name", BsonNull.Value) is BsonString n && specs.Count == 1 ? n : IndexName(k) } };
                    if (common != null) foreach (var e in common.Elements.Where(e => e.Name != "name")) spec[e.Name] = e.Value;
                    return spec;
                }));
                var r = await Command(Db(c), new BsonDocument { { "createIndexes", c.Collection }, { "indexes", indexes } });
                return Value(r, string.Join(", ", indexes.Select(i => i["name"].AsString)));
            }
            case "dropIndex" or "dropIndexes":
            {
                var target = c.ArgAt(0) ?? (c.Method == "dropIndexes" ? "*" : throw new ApiException("dropIndex() takes the index name or its keys."));
                return Value(await Command(Db(c), new BsonDocument { { "dropIndexes", c.Collection }, { "index", target } }));
            }
            case "getIndexes" or "getIndexSpecs" or "indexes":
            {
                var list = await (await coll.Indexes.ListAsync(ct)).ToListAsync(ct);
                return new ShellResult { Kind = "docs", Db = dbName, Collection = c.Collection, Docs = Js(list) };
            }
            case "getIndexKeys":
            {
                var list = await (await coll.Indexes.ListAsync(ct)).ToListAsync(ct);
                return Value(new BsonArray(list.Select(i => i["key"])));
            }
            case "drop":
                await Db(c).DropCollectionAsync(c.Collection, ct);
                return Value(true, $"Collection {c.Collection} dropped");
            case "renameCollection":
            {
                var to = c.ArgAt(0) is BsonString s ? s.Value : throw new ApiException("renameCollection() takes the new name.");
                var dropTarget = c.ArgAt(1) is BsonBoolean { Value: true };
                await Db(c).RenameCollectionAsync(c.Collection, to, new RenameCollectionOptions { DropTarget = dropTarget }, ct);
                return Value(new BsonDocument("ok", 1), $"Renamed to {to}");
            }
            case "stats" or "dataSize" or "storageSize" or "totalIndexSize" or "totalSize" or "isCapped":
            {
                var stats = await CollStatsAsync(Db(c), c.Collection!, ct);
                return c.Method switch
                {
                    "stats" => Value(stats),
                    "dataSize" => Value(stats.GetValue("size", 0)),
                    "storageSize" => Value(stats.GetValue("storageSize", 0)),
                    "totalIndexSize" => Value(stats.GetValue("totalIndexSize", 0)),
                    "totalSize" => Value(stats.GetValue("totalSize", stats.GetValue("storageSize", 0).ToInt64() + stats.GetValue("totalIndexSize", 0).ToInt64())),
                    _ => Value(stats.GetValue("capped", false)),
                };
            }
            case "getName":
                return Value(c.Collection!);
            case "getFullName":
                return Value($"{dbName}.{c.Collection}");
            case "exists":
            {
                var info = await (await Db(c).ListCollectionsAsync(new ListCollectionsOptions { Filter = new BsonDocument("name", c.Collection) }, ct)).FirstOrDefaultAsync(ct);
                return Value(info ?? (BsonValue)BsonNull.Value);
            }
            default:
                throw new ApiException($"{c.Method}() is not supported. Supported: find, findOne, aggregate, countDocuments, distinct, insertOne/Many, updateOne/Many, replaceOne, deleteOne/Many, findOneAnd…, createIndex, dropIndex, getIndexes, drop, renameCollection, stats.");
        }
    }

    static BsonDocument UpdateReply(ReplaceOneResult r)
    {
        var d = new BsonDocument { { "acknowledged", r.IsAcknowledged } };
        if (!r.IsAcknowledged) return d;
        d["matchedCount"] = r.MatchedCount;
        d["modifiedCount"] = r.IsModifiedCountAvailable ? r.ModifiedCount : BsonNull.Value;
        d["upsertedId"] = r.UpsertedId ?? BsonNull.Value;
        return d;
    }

    static BsonDocument UpdateReply(UpdateResult r)
    {
        var d = new BsonDocument { { "acknowledged", r.IsAcknowledged } };
        if (!r.IsAcknowledged) return d;
        d["matchedCount"] = r.MatchedCount;
        d["modifiedCount"] = r.IsModifiedCountAvailable ? r.ModifiedCount : BsonNull.Value;
        d["upsertedId"] = r.UpsertedId ?? BsonNull.Value;
        return d;
    }

    /// <summary>The name MongoDB gives an index by default: field_direction pairs joined by "_".</summary>
    public static string IndexName(BsonDocument keys) => string.Join('_', keys.Elements.Select(e => $"{e.Name}_{(e.Value.IsNumeric ? e.Value.ToInt32().ToString() : e.Value.ToString())}"));

    /// <summary>Collection statistics through $collStats (collStats is deprecated); views and missing collections give {}.</summary>
    public static async Task<BsonDocument> CollStatsAsync(IMongoDatabase db, string coll, CancellationToken ct)
    {
        var c = db.GetCollection<BsonDocument>(coll);
        var stage = new BsonDocument("$collStats", new BsonDocument { { "storageStats", new BsonDocument() }, { "count", new BsonDocument() } });
        try
        {
            var r = await (await c.AggregateAsync<BsonDocument>(new[] { stage }, cancellationToken: ct)).FirstOrDefaultAsync(ct);
            if (r == null) return [];
            var s = r.GetValue("storageStats", new BsonDocument()).AsBsonDocument;
            s["ns"] = r.GetValue("ns", $"{db.DatabaseNamespace.DatabaseName}.{coll}");
            // A sharded collection reports the count per shard; storageStats.count is per shard too.
            return s;
        }
        catch (MongoCommandException) { return []; }
    }

    async Task<ShellResult> FindAsync(ShellCommand c, IMongoCollection<BsonDocument> coll)
    {
        var filter = c.DocAt(0, "filter");
        var projection = c.DocAt(1, "projection");
        var opts = new FindOptions();
        BsonDocument? sort = null;
        int? limit = null, skip = null;
        var count = false;
        foreach (var call in c.Chain)
        {
            var a = call.Args.Count > 0 ? call.Args[0] : null;
            switch (call.Name)
            {
                case "sort": sort = a as BsonDocument ?? throw new ApiException("sort() takes a document: { field: 1 }."); break;
                case "limit": limit = a is { IsNumeric: true } ? a.ToInt32() : throw new ApiException("limit() takes a number."); break;
                case "skip": skip = a is { IsNumeric: true } ? a.ToInt32() : throw new ApiException("skip() takes a number."); break;
                case "project" or "projection": projection = a as BsonDocument ?? throw new ApiException("projection() takes a document."); break;
                case "hint": opts.Hint = a; break;
                case "collation": opts.Collation = Collation.FromBsonDocument(a?.AsBsonDocument ?? throw new ApiException("collation() takes a document.")); break;
                case "maxTimeMS": opts.MaxTime = TimeSpan.FromMilliseconds(a?.ToDouble() ?? 0); break;
                case "comment": opts.Comment = a; break;
                case "batchSize": opts.BatchSize = a?.ToInt32(); break;
                case "allowDiskUse": opts.AllowDiskUse = a?.ToBoolean() ?? true; break;
                case "count" or "size" or "itcount": count = true; break;
                case "toArray" or "pretty": break;
                default: throw new ApiException($"Cursor method {call.Name}() is not supported.");
            }
        }
        var dbName = DbName(c);
        if (count)
        {
            var n = await coll.CountDocumentsAsync(Filter(filter), new CountOptions { Limit = limit, Skip = skip, Hint = opts.Hint, MaxTime = opts.MaxTime }, ct);
            return new ShellResult { Kind = "value", Db = dbName, Collection = c.Collection, Value = J(n) };
        }
        var f = coll.Find(Filter(filter), opts);
        if (sort != null) f = f.Sort(sort);
        if (skip != null) f = f.Skip(skip);
        var take = Math.Min(limit is > 0 ? limit.Value : int.MaxValue, maxDocs);
        f = f.Limit(limit is > 0 && limit.Value <= maxDocs ? limit : maxDocs + 1);
        var cur = await f.Project<BsonDocument>(projection ?? new BsonDocument()).ToCursorAsync(ct);
        var (docs, more) = await Take(cur, take);
        var editable = docs.All(d => d.Contains("_id")) && (projection == null || projection.ElementCount == 0);
        return new ShellResult { Kind = "docs", Db = dbName, Collection = c.Collection, Docs = Js(docs), Truncated = more && !(limit is > 0 && limit <= maxDocs), Editable = editable };
    }

    async Task<ShellResult> FindOneAndAsync(ShellCommand c, IMongoCollection<BsonDocument> coll)
    {
        var filter = Filter(c.DocAt(0, "filter") ?? throw new ApiException($"{c.Method}() needs a filter."));
        var o = c.DocAt(c.Method == "findOneAndDelete" ? 1 : 2, "options");
        var after = o != null && (o.GetValue("returnDocument", "before").ToString() == "after" || o.GetValue("returnNewDocument", false).ToBoolean());
        var sort = o?.GetValue("sort", BsonNull.Value) as BsonDocument;
        var projection = o?.GetValue("projection", BsonNull.Value) as BsonDocument;
        var upsert = o?.GetValue("upsert", false).ToBoolean() ?? false;
        var rd = after ? ReturnDocument.After : ReturnDocument.Before;
        BsonDocument? doc = c.Method switch
        {
            "findOneAndUpdate" => await coll.FindOneAndUpdateAsync(filter, Update(c.ArgAt(1)), new FindOneAndUpdateOptions<BsonDocument> { Sort = sort, Projection = projection, IsUpsert = upsert, ReturnDocument = rd }, ct),
            "findOneAndReplace" => await coll.FindOneAndReplaceAsync(filter, c.DocAt(1, "replacement") ?? throw new ApiException("findOneAndReplace() needs the new document."), new FindOneAndReplaceOptions<BsonDocument> { Sort = sort, Projection = projection, IsUpsert = upsert, ReturnDocument = rd }, ct),
            _ => await coll.FindOneAndDeleteAsync(filter, new FindOneAndDeleteOptions<BsonDocument> { Sort = sort, Projection = projection }, ct),
        };
        if (doc == null) return new ShellResult { Kind = "value", Db = DbName(c), Collection = c.Collection, Value = J(BsonNull.Value), Message = "No document matched." };
        return new ShellResult { Kind = "docs", Db = DbName(c), Collection = c.Collection, Docs = [J(doc)], Editable = projection == null && c.Method != "findOneAndDelete" };
    }

    /// <summary>explain() of find, aggregate, count, distinct, update and delete, as the explain command.</summary>
    async Task<ShellResult> ExplainAsync(ShellCommand c, string verbosity)
    {
        var coll = c.Collection!;
        BsonDocument cmd;
        switch (c.Method)
        {
            case "find":
                cmd = new BsonDocument { { "find", coll }, { "filter", c.DocAt(0, "filter") ?? [] } };
                if (c.DocAt(1, "projection") is { } p) cmd["projection"] = p;
                foreach (var call in c.Chain.Where(x => x.Name != "explain"))
                {
                    var a = call.Args.Count > 0 ? call.Args[0] : BsonNull.Value;
                    switch (call.Name)
                    {
                        case "sort" or "limit" or "skip" or "hint" or "collation" or "comment": cmd[call.Name] = a; break;
                        case "project" or "projection": cmd["projection"] = a; break;
                        case "maxTimeMS": cmd["maxTimeMS"] = a; break;
                        case "toArray" or "pretty": break;
                        default: throw new ApiException($"{call.Name}() can't be explained.");
                    }
                }
                break;
            case "aggregate":
                cmd = new BsonDocument { { "aggregate", coll }, { "pipeline", c.ArgAt(0) as BsonArray ?? throw new ApiException("aggregate() takes a pipeline.") }, { "cursor", new BsonDocument() } };
                if (c.DocAt(1, "options") is { } ao) foreach (var e in ao.Elements) cmd[e.Name] = e.Value;
                break;
            case "count" or "countDocuments":
                cmd = new BsonDocument { { "count", coll }, { "query", c.DocAt(0, "filter") ?? [] } };
                break;
            case "distinct":
                cmd = new BsonDocument { { "distinct", coll }, { "key", c.ArgAt(0) ?? "" }, { "query", c.DocAt(1, "filter") ?? [] } };
                break;
            case "updateOne" or "updateMany":
                cmd = new BsonDocument { { "update", coll }, { "updates", new BsonArray { new BsonDocument { { "q", c.DocAt(0, "filter") ?? [] }, { "u", c.ArgAt(1) ?? new BsonDocument() }, { "multi", c.Method == "updateMany" } } } } };
                break;
            case "deleteOne" or "deleteMany":
                cmd = new BsonDocument { { "delete", coll }, { "deletes", new BsonArray { new BsonDocument { { "q", c.DocAt(0, "filter") ?? [] }, { "limit", c.Method == "deleteOne" ? 1 : 0 } } } } };
                break;
            default:
                throw new ApiException($"{c.Method}() can't be explained.");
        }
        var r = await Command(Db(c), new BsonDocument { { "explain", cmd }, { "verbosity", verbosity } });
        return new ShellResult { Kind = "value", Db = DbName(c), Collection = coll, Value = J(r), Explain = true };
    }
}
