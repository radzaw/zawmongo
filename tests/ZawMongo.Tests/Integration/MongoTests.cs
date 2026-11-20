using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using ZawMongo.Tests.Infrastructure;

namespace ZawMongo.Tests.Integration;

/// <summary>The API against a real server: browsing, documents, the shell, indexes, read-only sessions, import and export.</summary>
public sealed class MongoTests : IAsyncLifetime
{
    TestApp app = null!;
    readonly string db = TestServer.NewDatabase();
    string sid = "";

    public async Task InitializeAsync()
    {
        app = await TestApp.StartAsync();
        if (!TestServer.Enabled) return;
        var docs = Enumerable.Range(1, 30).Select(i => new BsonDocument { { "n", i }, { "name", $"item {i}" }, { "tags", new BsonArray { "a", i % 2 == 0 ? "even" : "odd" } }, { "price", i * 1.5 } });
        await TestServer.Client().GetDatabase(db).GetCollection<BsonDocument>("items").InsertManyAsync(docs);
        sid = (await app.PostAsync("/connect", new { profile = TestServer.Profile() })).Expect().GetProperty("sid").GetString()!;
    }

    public async Task DisposeAsync()
    {
        if (TestServer.Enabled) await TestServer.Client().DropDatabaseAsync(db);
        await app.DisposeAsync();
    }

    Task<ApiResult> Exec(string script, string? database = null, string? s = null) =>
        app.PostAsync($"/s/{s ?? sid}/exec", new { script, database = database ?? db });

    [MongoFact]
    public async Task Tree_lists_databases_and_collections_with_counts()
    {
        var dbs = (await app.GetAsync($"/s/{sid}/databases")).Expect();
        Assert.Contains(dbs.EnumerateArray(), d => d.GetProperty("name").GetString() == db);
        var colls = (await app.GetAsync($"/s/{sid}/collections?db={db}")).Expect();
        var items = Assert.Single(colls.EnumerateArray());
        Assert.Equal("items", items.GetProperty("name").GetString());
        Assert.Equal(30, items.GetProperty("count").GetInt64());
    }

    [MongoFact]
    public async Task Find_pages_sorts_and_counts()
    {
        var res = await app.PostAsync($"/s/{sid}/find", new { db, coll = "items", filter = "{ tags: 'even' }", sort = "{ n: -1 }", skip = 2, limit = 5 });
        var r = res.Expect();
        Assert.Equal(15, r.GetProperty("total").GetInt64());
        var docs = r.GetProperty("docs").EnumerateArray().ToList();
        Assert.Equal(5, docs.Count);
        Assert.Equal("26", docs[0].GetProperty("n").GetProperty("$numberInt").GetString()); // 30, 28, then 26
        Assert.Contains(res.Log, l => l.EndsWith(".items.find({ tags: \"even\" }).sort({ n: -1 }).skip(2).limit(5)"));
    }

    [MongoFact]
    public async Task Documents_are_inserted_edited_by_field_replaced_and_deleted_keeping_types()
    {
        var ins = (await app.PostAsync($"/s/{sid}/docs/insert", new { db, coll = "edit", text = "{ a: NumberLong(1), b: 'x', nested: { c: 1 } }" })).Expect();
        var id = ins.GetProperty("ids")[0];

        var set = (await app.PostAsync($"/s/{sid}/docs/field", new { db, coll = "edit", id, path = "nested.c", value = "ISODate('2024-01-02T00:00:00Z')" })).Expect();
        Assert.True(set.GetProperty("doc").GetProperty("nested").GetProperty("c").TryGetProperty("$date", out _));

        var doc = (await app.PostAsync($"/s/{sid}/doc", new { db, coll = "edit", id })).Expect();
        Assert.Equal("1", doc.GetProperty("a").GetProperty("$numberLong").GetString());

        (await app.PostAsync($"/s/{sid}/docs/replace", new { db, coll = "edit", id, text = "{ only: true }" })).Expect();
        var stored = await TestServer.Client().GetDatabase(db).GetCollection<BsonDocument>("edit").Find(new BsonDocument()).FirstAsync();
        Assert.Equal(["_id", "only"], stored.Names.ToArray());

        var bad = await app.PostAsync($"/s/{sid}/docs/replace", new { db, coll = "edit", id, text = "{ _id: 5 }" });
        Assert.False(bad.Ok);
        Assert.Contains("_id", bad.Error);

        Assert.Equal(1, (await app.PostAsync($"/s/{sid}/docs/delete", new { db, coll = "edit", ids = new[] { id } })).Expect().GetProperty("deleted").GetInt64());
    }

    [MongoFact]
    public async Task Shell_scripts_run_statement_by_statement()
    {
        var r = (await Exec("""
            db.shell.insertMany([{ k: 1 }, { k: 2 }, { k: 3 }])
            db.shell.updateMany({ k: { $gte: 2 } }, { $set: { big: true } })
            db.shell.find({ big: true }, { _id: 0 }).sort({ k: -1 })
            db.shell.countDocuments({})
            db.shell.aggregate([{ $group: { _id: null, sum: { $sum: '$k' } } }])
            use other_db_unused
            db.getName()
            """)).Expect();
        Assert.Equal(7, r.GetProperty("executed").GetInt32());
        Assert.Equal("other_db_unused", r.GetProperty("database").GetString());
        var res = r.GetProperty("results").EnumerateArray().ToList();
        Assert.Equal("2 matched, 2 modified", res[1].GetProperty("message").GetString());
        var found = res[2].GetProperty("docs").EnumerateArray().ToList();
        Assert.Equal(2, found.Count);
        Assert.False(res[2].GetProperty("editable").GetBoolean()); // projected
        Assert.Equal("3", res[3].GetProperty("value").GetProperty("$numberLong").GetString());
        Assert.Equal("6", res[4].GetProperty("docs")[0].GetProperty("sum").GetProperty("$numberInt").GetString());
        Assert.Equal("other_db_unused", res[6].GetProperty("value").GetString());
    }

    [MongoFact]
    public async Task Errors_stop_the_script_and_name_the_statement()
    {
        var r = (await Exec("db.items.find({})\ndb.items.find({ $bogus: 1 })\ndb.items.find({})")).Expect();
        Assert.Equal(1, r.GetProperty("executed").GetInt32());
        var err = Assert.Single(r.GetProperty("errors").EnumerateArray());
        Assert.Equal(1, err.GetProperty("statement").GetInt32());
        Assert.Contains("$bogus", err.GetProperty("message").GetString());
    }

    [MongoFact]
    public async Task Find_stops_at_max_docs_and_says_so()
    {
        var r = (await app.PostAsync($"/s/{sid}/exec", new { script = "db.items.find()", database = db, maxDocs = 10 })).Expect();
        var res = r.GetProperty("results")[0];
        Assert.Equal(10, res.GetProperty("docs").GetArrayLength());
        Assert.True(res.GetProperty("truncated").GetBoolean());
        Assert.True(res.GetProperty("editable").GetBoolean());
    }

    [MongoFact]
    public async Task Explain_returns_the_plan()
    {
        var r = (await Exec("db.items.find({ n: 5 }).explain('executionStats')")).Expect();
        var res = r.GetProperty("results")[0];
        Assert.True(res.GetProperty("explain").GetBoolean());
        Assert.True(res.GetProperty("value").TryGetProperty("queryPlanner", out _));
        Assert.True(res.GetProperty("value").TryGetProperty("executionStats", out _));
    }

    [MongoFact]
    public async Task Indexes_are_created_listed_with_usage_and_dropped()
    {
        Assert.Equal("n_1_name_-1", (await app.PostAsync($"/s/{sid}/indexes/create", new { db, coll = "items", keys = "{ n: 1, name: -1 }", options = "{ unique: true }" })).Expect().GetProperty("name").GetString());
        var c = (await app.GetAsync($"/s/{sid}/collection?db={db}&coll=items")).Expect();
        var idx = c.GetProperty("indexes").EnumerateArray().Select(i => i.GetProperty("name").GetString()).ToList();
        Assert.Equal(["_id_", "n_1_name_-1"], idx);
        Assert.True(c.GetProperty("indexes")[1].GetProperty("spec").GetProperty("unique").GetBoolean());
        (await app.PostAsync($"/s/{sid}/indexes/drop", new { db, coll = "items", name = "n_1_name_-1" })).Expect();
        Assert.False((await app.PostAsync($"/s/{sid}/indexes/drop", new { db, coll = "items", name = "_id_" })).Ok);
    }

    [MongoFact]
    public async Task Read_only_sessions_refuse_every_change()
    {
        var ro = (await app.PostAsync("/connect", new { profile = TestServer.Profile(readOnly: true) })).Expect().GetProperty("sid").GetString()!;
        Assert.True((await Exec("db.items.find({ n: 1 })", s: ro)).Expect().GetProperty("executed").GetInt32() == 1);
        foreach (var w in new[] { "db.items.deleteMany({})", "db.items.aggregate([{ $out: 'x' }])", "db.runCommand({ drop: 'items' })" })
        {
            var r = (await Exec(w, s: ro)).Expect();
            Assert.Contains("Read-only", r.GetProperty("errors")[0].GetProperty("message").GetString());
        }
        Assert.False((await app.PostAsync($"/s/{ro}/docs/insert", new { db, coll = "items", text = "{}" })).Ok);
        Assert.False((await app.PostAsync($"/s/{ro}/collections/drop", new { db, coll = "items" })).Ok);
        Assert.Equal(30, await TestServer.Client().GetDatabase(db).GetCollection<BsonDocument>("items").CountDocumentsAsync(new BsonDocument()));
    }

    [MongoFact]
    public async Task Schema_sample_describes_the_fields()
    {
        var r = (await app.PostAsync($"/s/{sid}/schema", new { db, coll = "items", size = 100 })).Expect();
        Assert.Equal(30, r.GetProperty("sampled").GetInt32());
        var price = r.GetProperty("fields").EnumerateArray().First(f => f.GetProperty("path").GetString() == "price");
        Assert.Equal("double", price.GetProperty("types")[0].GetProperty("type").GetString());
    }

    [MongoFact]
    public async Task Import_and_export_round_trip()
    {
        using var content = new StringContent("name,qty\nfoo,1\nbar,2\n");
        var up = await app.Http.PostAsync("/api/import/upload?name=data.csv", content);
        var file = JsonDocument.Parse(await up.Content.ReadAsStringAsync()).RootElement.GetProperty("data");
        Assert.Equal("csv", file.GetProperty("format").GetString());
        var r = (await app.PostAsync($"/s/{sid}/import/run", new { fileId = file.GetProperty("id").GetString(), db, coll = "imported" })).Expect();
        Assert.Equal(2, r.GetProperty("inserted").GetInt64());

        var json = await app.Http.GetStringAsync($"/api/s/{sid}/export?db={db}&coll=imported&format=ndjson&projection={Uri.EscapeDataString("{ _id: 0 }")}&sort={Uri.EscapeDataString("{ qty: 1 }")}");
        Assert.Equal("{\"name\":\"foo\",\"qty\":1}\n{\"name\":\"bar\",\"qty\":2}\n", json.Replace(" ", ""));
    }

    [MongoFact]
    public async Task Monitor_operations_and_server_documents_answer()
    {
        var m = (await app.GetAsync($"/s/{sid}/monitor")).Expect();
        Assert.True(m.GetProperty("connections").GetProperty("current").GetDouble() > 0);
        Assert.Equal(JsonValueKind.Array, (await app.GetAsync($"/s/{sid}/ops")).Expect().ValueKind);
        Assert.True((await app.GetAsync($"/s/{sid}/server?kind=build")).Expect().TryGetProperty("version", out _));
        // Either the members of the set, or why there are none.
        var repl = (await app.GetAsync($"/s/{sid}/replication")).Expect();
        Assert.True(repl.GetProperty("replicaSet").GetBoolean() ? repl.GetProperty("members").GetArrayLength() > 0 : repl.GetProperty("message").GetString()!.Length > 0);
    }
}
