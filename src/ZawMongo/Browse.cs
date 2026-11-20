using System.Diagnostics;
using MongoDB.Bson;
using MongoDB.Driver;

namespace ZawMongo;

public sealed record FindRequest(string Db, string Coll, string? Filter, string? Projection, string? Sort, int Skip = 0, int Limit = 50, bool Count = true, string? Hint = null, string? Collation = null);
public sealed record DocInsertRequest(string Db, string Coll, string Text);
public sealed record DocReplaceRequest(string Db, string Coll, BsonJson Id, string Text);
public sealed record DocDeleteRequest(string Db, string Coll, List<BsonJson> Ids);
/// <summary>Sets (Value: shell syntax) or removes (Value null) one field of a document.</summary>
public sealed record DocFieldRequest(string Db, string Coll, BsonJson Id, string Path, string? Value);
public sealed record DocBulkRequest(string Db, string Coll, string Filter, string? Update, bool Delete = false);

/// <summary>Databases, collections, documents: what the tree, the Database tab and the Documents tab show.</summary>
public static class Browse
{
    static BsonJson J(BsonValue v) => new(v);

    /// <summary>Databases with their size on disk. Users without listDatabases see the ones they have privileges on.</summary>
    public static async Task<List<object>> DatabasesAsync(DbSession s, OpLog log, CancellationToken ct)
    {
        var r = await log.Timed("db.adminCommand({ listDatabases: 1, authorizedDatabases: true })", () =>
            s.Db("admin").RunCommandAsync<BsonDocument>(new BsonDocument { { "listDatabases", 1 }, { "authorizedDatabases", true } }, cancellationToken: ct));
        var list = r["databases"].AsBsonArray.OfType<BsonDocument>()
            .Select(d => (name: d["name"].AsString, size: d.GetValue("sizeOnDisk", 0).ToInt64(), empty: d.GetValue("empty", false).ToBoolean()))
            .ToList();
        var filter = s.Profile.Databases?.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (filter is { Length: > 0 })
        {
            list = list.Where(d => filter.Contains(d.name, StringComparer.Ordinal)).ToList();
            // Databases the user can use but not list (no listDatabases privilege, nothing in them yet) still show.
            foreach (var f in filter.Where(f => list.All(d => d.name != f))) list.Add((f, 0, true));
        }
        return list.OrderBy(d => d.name, StringComparer.Ordinal).Select(d => (object)new { d.name, d.size, d.empty }).ToList();
    }

    /// <summary>Collections and views of a database, with counts and sizes (for up to 400 collections).</summary>
    public static async Task<List<object>> CollectionsAsync(DbSession s, string db, OpLog log, CancellationToken ct)
    {
        var mdb = s.Db(db);
        var infos = await log.Timed($"{Shell.Ref(db, null)}.getCollectionInfos()", async () =>
            await (await mdb.ListCollectionsAsync(cancellationToken: ct)).ToListAsync(ct));
        infos = infos.OrderBy(i => i["name"].AsString, StringComparer.Ordinal).ToList();
        var stats = new Dictionary<string, BsonDocument>();
        var withStats = infos.Where(i => i.GetValue("type", "collection").AsString == "collection").Take(400).ToList();
        await Parallel.ForEachAsync(withStats, new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = ct }, async (i, c) =>
        {
            var st = await ShellRunner.CollStatsAsync(mdb, i["name"].AsString, c);
            lock (stats) stats[i["name"].AsString] = st;
        });
        return infos.Select(i =>
        {
            var name = i["name"].AsString;
            var type = i.GetValue("type", "collection").AsString;
            stats.TryGetValue(name, out var st);
            var opts = i.GetValue("options", new BsonDocument()).AsBsonDocument;
            return (object)new
            {
                name,
                type,
                count = st?.GetValue("count", BsonNull.Value) is { IsNumeric: true } n ? n.ToInt64() : (long?)null,
                size = st?.GetValue("size", BsonNull.Value) is { IsNumeric: true } sz ? sz.ToInt64() : (long?)null,
                storageSize = st?.GetValue("storageSize", BsonNull.Value) is { IsNumeric: true } ss ? ss.ToInt64() : (long?)null,
                indexSize = st?.GetValue("totalIndexSize", BsonNull.Value) is { IsNumeric: true } ix ? ix.ToInt64() : (long?)null,
                indexes = st?.GetValue("nindexes", BsonNull.Value) is { IsNumeric: true } ni ? ni.ToInt32() : (int?)null,
                avgObjSize = st?.GetValue("avgObjSize", BsonNull.Value) is { IsNumeric: true } av ? av.ToDouble() : (double?)null,
                capped = opts.GetValue("capped", false).ToBoolean(),
                timeseries = type == "timeseries",
                viewOn = opts.GetValue("viewOn", BsonNull.Value) is BsonString v ? v.Value : null,
                validator = opts.Contains("validator"),
            };
        }).ToList();
    }

    /// <summary>Everything the Collection tab shows: options, indexes with usage, statistics.</summary>
    public static async Task<object> CollectionAsync(DbSession s, string db, string coll, OpLog log, CancellationToken ct)
    {
        var mdb = s.Db(db);
        var info = await log.Timed($"{Shell.Ref(db, null)}.getCollectionInfos({{ name: {Shell.Quote(coll)} }})", async () =>
            await (await mdb.ListCollectionsAsync(new ListCollectionsOptions { Filter = new BsonDocument("name", coll) }, ct)).FirstOrDefaultAsync(ct))
            ?? throw new ApiException($"Collection {db}.{coll} doesn't exist.");
        var type = info.GetValue("type", "collection").AsString;
        var options = info.GetValue("options", new BsonDocument()).AsBsonDocument;
        if (type == "view")
            return new { name = coll, type, options = J(options), indexes = Array.Empty<object>(), stats = (BsonJson?)null };

        var c = mdb.GetCollection<BsonDocument>(coll);
        var indexes = await log.Timed($"{Shell.Ref(db, coll)}.getIndexes()", async () => await (await c.Indexes.ListAsync(ct)).ToListAsync(ct));
        var usage = new Dictionary<string, BsonDocument>();
        try
        {
            var cur = await c.AggregateAsync<BsonDocument>(new[] { new BsonDocument("$indexStats", new BsonDocument()) }, cancellationToken: ct);
            foreach (var u in await cur.ToListAsync(ct)) usage[u["name"].AsString] = u;
        }
        catch (MongoCommandException) { /* no privilege: usage stays unknown */ }
        var stats = await ShellRunner.CollStatsAsync(mdb, coll, ct);
        var sizes = stats.GetValue("indexSizes", new BsonDocument()).AsBsonDocument;
        return new
        {
            name = coll,
            type,
            options = J(options),
            stats = J(stats),
            indexes = indexes.Select(i =>
            {
                var name = i["name"].AsString;
                usage.TryGetValue(name, out var u);
                var acc = u?.GetValue("accesses", new BsonDocument()).AsBsonDocument;
                return new
                {
                    name,
                    spec = J(i),
                    key = J(i["key"]),
                    size = sizes.GetValue(name, BsonNull.Value) is { IsNumeric: true } sz ? sz.ToInt64() : (long?)null,
                    ops = acc?.GetValue("ops", BsonNull.Value) is { IsNumeric: true } o ? o.ToInt64() : (long?)null,
                    since = acc?.GetValue("since", BsonNull.Value) is BsonDateTime d ? d.ToUniversalTime() : (DateTime?)null,
                    building = u?.GetValue("building", false).ToBoolean() ?? false,
                };
            }).ToList(),
        };
    }

    /// <summary>One page of documents (Documents tab), with the total count when asked for.</summary>
    public static async Task<object> FindAsync(DbSession s, FindRequest r, OpLog log, CancellationToken ct)
    {
        var filter = Shell.ParseDocument(r.Filter, "filter");
        var projection = Shell.ParseDocument(r.Projection, "projection");
        var sort = Shell.ParseDocument(r.Sort, "sort");
        var limit = Math.Clamp(r.Limit, 1, 100_000);
        var skip = Math.Max(0, r.Skip);
        var c = s.Coll(r.Db, r.Coll);
        var opts = new FindOptions();
        if (!string.IsNullOrWhiteSpace(r.Hint)) opts.Hint = Shell.ParseValue(r.Hint);
        if (!string.IsNullOrWhiteSpace(r.Collation)) opts.Collation = Collation.FromBsonDocument(Shell.ParseDocument(r.Collation, "collation"));

        var text = $"{Shell.Ref(r.Db, r.Coll)}.find({Shell.Show(filter)}{(projection.ElementCount > 0 ? ", " + Shell.Show(projection) : "")})"
            + (sort.ElementCount > 0 ? $".sort({Shell.Show(sort)})" : "") + (skip > 0 ? $".skip({skip})" : "") + $".limit({limit})";
        var sw = Stopwatch.StartNew();
        var docs = await log.Timed(text, async () =>
        {
            var f = c.Find(new BsonDocumentFilterDefinition<BsonDocument>(filter), opts).Skip(skip).Limit(limit);
            if (sort.ElementCount > 0) f = f.Sort(sort);
            return await f.Project<BsonDocument>(projection).ToListAsync(ct);
        });
        var ms = sw.Elapsed.TotalMilliseconds;
        long? total = null;
        var estimated = false;
        if (r.Count)
        {
            if (filter.ElementCount == 0)
            {
                total = await c.EstimatedDocumentCountAsync(cancellationToken: ct);
                estimated = true;
            }
            else
            {
                try
                {
                    total = await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.countDocuments({Shell.Show(filter)}, {{ maxTimeMS: 5000 }})", () =>
                        c.CountDocumentsAsync(new BsonDocumentFilterDefinition<BsonDocument>(filter), new CountOptions { MaxTime = TimeSpan.FromSeconds(5), Hint = opts.Hint, Collation = opts.Collation }, ct));
                }
                catch (MongoExecutionTimeoutException) { log.Note("Counting took longer than 5 s; the total is unknown."); }
            }
        }
        var editable = projection.ElementCount == 0 || docs.All(d => d.Contains("_id"));
        return new { docs = docs.Select(d => J(d)).ToList(), total, estimated, ms, editable, partial = projection.ElementCount > 0 };
    }

    static BsonDocument ById(BsonValue id) => new("_id", id);

    public static async Task<object> InsertAsync(DbSession s, DocInsertRequest r, OpLog log, CancellationToken ct)
    {
        var args = Shell.ParseArgs(r.Text);
        var docs = args.Count == 1 && args[0] is BsonArray a ? a.ToList() : args.ToList();
        if (docs.Count == 0 || docs.Any(d => d is not BsonDocument)) throw new ApiException("Enter a document { … } or an array of documents [ { … }, { … } ].");
        var list = docs.Select(d => d.AsBsonDocument).ToList();
        var c = s.Coll(r.Db, r.Coll);
        if (list.Count == 1)
            await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.insertOne({Shell.Show(list[0])})", async () => { await c.InsertOneAsync(list[0], cancellationToken: ct); return 0; });
        else
            await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.insertMany([ /* {list.Count} documents */ ])", async () => { await c.InsertManyAsync(list, cancellationToken: ct); return 0; });
        return new { inserted = list.Count, ids = list.Select(d => J(d["_id"])).ToList() };
    }

    public static async Task<object> ReplaceAsync(DbSession s, DocReplaceRequest r, OpLog log, CancellationToken ct)
    {
        var doc = Shell.ParseDocument(r.Text);
        var id = r.Id.Value;
        if (doc.TryGetValue("_id", out var newId) && !newId.Equals(id))
            throw new ApiException("The _id of a document can't be changed. Insert a copy with the new _id and delete this one instead.");
        if (!doc.Contains("_id")) doc.InsertAt(0, new BsonElement("_id", id));
        var res = await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.replaceOne({Shell.Show(ById(id))}, {Shell.Show(doc)})", () =>
            s.Coll(r.Db, r.Coll).ReplaceOneAsync(ById(id), doc, cancellationToken: ct));
        if (res.MatchedCount == 0) throw new ApiException("The document no longer exists (another user may have deleted it).");
        return new { matched = res.MatchedCount, modified = res.ModifiedCount, doc = J(doc) };
    }

    public static async Task<object> SetFieldAsync(DbSession s, DocFieldRequest r, OpLog log, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(r.Path) || r.Path == "_id") throw new ApiException("The _id field can't be changed.");
        var id = r.Id.Value;
        var update = r.Value == null
            ? new BsonDocument("$unset", new BsonDocument(r.Path, ""))
            : new BsonDocument("$set", new BsonDocument(r.Path, Shell.ParseValue(r.Value)));
        var c = s.Coll(r.Db, r.Coll);
        var res = await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.updateOne({Shell.Show(ById(id))}, {Shell.Show(update)})", () =>
            c.UpdateOneAsync(ById(id), update, cancellationToken: ct));
        if (res.MatchedCount == 0) throw new ApiException("The document no longer exists (another user may have deleted it).");
        var doc = await c.Find(ById(id)).FirstOrDefaultAsync(ct);
        return new { doc = doc == null ? null : J(doc) };
    }

    public static async Task<object> DeleteAsync(DbSession s, DocDeleteRequest r, OpLog log, CancellationToken ct)
    {
        if (r.Ids.Count == 0) return new { deleted = 0L };
        var filter = r.Ids.Count == 1 ? ById(r.Ids[0].Value) : new BsonDocument("_id", new BsonDocument("$in", new BsonArray(r.Ids.Select(i => i.Value))));
        var res = await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.{(r.Ids.Count == 1 ? "deleteOne" : "deleteMany")}({Shell.Show(filter)})", () =>
            s.Coll(r.Db, r.Coll).DeleteManyAsync(filter, ct));
        return new { deleted = res.DeletedCount };
    }

    /// <summary>updateMany / deleteMany over a filter (Documents tab › Update matching / Delete matching).</summary>
    public static async Task<object> BulkAsync(DbSession s, DocBulkRequest r, OpLog log, CancellationToken ct)
    {
        var filter = Shell.ParseDocument(r.Filter, "filter");
        var c = s.Coll(r.Db, r.Coll);
        if (r.Delete)
        {
            var d = await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.deleteMany({Shell.Show(filter)})", () => c.DeleteManyAsync(filter, ct));
            return new { deleted = d.DeletedCount };
        }
        var args = Shell.ParseArgs(r.Update ?? "");
        if (args.Count != 1) throw new ApiException("Enter one update: { $set: { … } } or a pipeline [ { $set: … } ].");
        UpdateDefinition<BsonDocument> update = args[0] switch
        {
            BsonDocument u when u.Names.All(n => n.StartsWith('$')) && u.ElementCount > 0 => new BsonDocumentUpdateDefinition<BsonDocument>(u),
            BsonArray p => new PipelineUpdateDefinition<BsonDocument>(PipelineDefinition<BsonDocument, BsonDocument>.Create(p.OfType<BsonDocument>())),
            _ => throw new ApiException("The update needs operators such as $set, $unset, $inc or $push."),
        };
        var res = await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.updateMany({Shell.Show(filter)}, {Shell.Show(args[0])})", () => c.UpdateManyAsync(filter, update, cancellationToken: ct));
        return new { matched = res.MatchedCount, modified = res.ModifiedCount };
    }
}
