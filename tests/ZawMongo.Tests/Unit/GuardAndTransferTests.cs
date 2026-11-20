using MongoDB.Bson;

namespace ZawMongo.Tests.Unit;

public class ReadOnlyGuardTests
{
    [Theory]
    [InlineData("db.c.find({ a: 1 }).sort({ b: 1 })")]
    [InlineData("db.c.aggregate([{ $match: {} }, { $group: { _id: '$x' } }])")]
    [InlineData("db.c.countDocuments({})")]
    [InlineData("db.runCommand({ dbStats: 1 })")]
    [InlineData("db.runCommand('ping')")]
    [InlineData("db.adminCommand({ listDatabases: 1 })")]
    [InlineData("db.c.explain('executionStats').find({})")]
    [InlineData("show dbs")]
    [InlineData("use other")]
    public void Reads_pass(string statement) => Assert.Null(ReadOnlyGuard.Check(Shell.Parse(statement)));

    [Theory]
    [InlineData("db.c.insertOne({ a: 1 })")]
    [InlineData("db.c.updateMany({}, { $set: { a: 1 } })")]
    [InlineData("db.c.deleteOne({})")]
    [InlineData("db.c.drop()")]
    [InlineData("db.c.createIndex({ a: 1 })")]
    [InlineData("db.c.aggregate([{ $match: {} }, { $out: 'copy' }])")]
    [InlineData("db.c.aggregate([{ $facet: { x: [{ $merge: 'copy' }] } }])")]
    [InlineData("db.runCommand({ insert: 'c', documents: [{}] })")]
    [InlineData("db.runCommand({ aggregate: 'c', pipeline: [{ $out: 'x' }], cursor: {} })")]
    [InlineData("db.adminCommand({ shutdown: 1 })")]
    [InlineData("db.dropDatabase()")]
    [InlineData("db.createUser({ user: 'x', pwd: 'y', roles: [] })")]
    [InlineData("db.c.explain().deleteMany({})")]
    public void Writes_are_refused(string statement) => Assert.NotNull(ReadOnlyGuard.Check(Shell.Parse(statement)));
}

public class TransferTests
{
    [Fact]
    public void Json_arrays_ndjson_and_extended_json_are_read()
    {
        var arr = Transfer.ReadJson(new StringReader("[{ \"a\": 1 }, { \"_id\": { \"$oid\": \"5f1d7f3b9d1e8a0001a1b2c3\" } }]")).ToList();
        Assert.Equal(2, arr.Count);
        Assert.Equal(BsonType.ObjectId, arr[1]["_id"].BsonType);
        var nd = Transfer.ReadJson(new StringReader("{\"a\":1}\n{\"a\":2}\n\n{\"d\":{\"$date\":\"2024-01-02T00:00:00Z\"}}\n")).ToList();
        Assert.Equal(3, nd.Count);
        Assert.Equal(BsonType.DateTime, nd[2]["d"].BsonType);
    }

    [Fact]
    public void Csv_is_typed_nested_and_quoted()
    {
        var csv = "name;age;address.city;zip;active;note\n\"Smith; John\";42;Kraków;01234;true;\"two\nlines\"\nAnn;;Gdańsk;80-001;false;1.5\n";
        var docs = Transfer.ReadCsv(new StringReader(csv), null, typed: true).ToList();
        Assert.Equal(2, docs.Count);
        Assert.Equal("Smith; John", docs[0]["name"].AsString);
        Assert.Equal(42, docs[0]["age"].AsInt32);
        Assert.Equal("Kraków", docs[0]["address"]["city"].AsString);
        Assert.Equal("01234", docs[0]["zip"].AsString); // leading zero stays text
        Assert.True(docs[0]["active"].AsBoolean);
        Assert.Equal("two\nlines", docs[0]["note"].AsString);
        Assert.False(docs[1].Contains("age")); // empty cell: no field
        Assert.Equal(1.5, docs[1]["note"].AsDouble);
    }

    [Fact]
    public async Task Csv_export_writes_values_as_text_and_documents_as_json()
    {
        var docs = new List<BsonDocument>
        {
            BsonDocument.Parse("{ _id: 1, name: 'a,b', tags: ['x'], at: ISODate('2024-01-02T03:04:05Z') }"),
            BsonDocument.Parse("{ _id: 2, extra: true }"),
        };
        var w = new StringWriter();
        await Transfer.WriteAsync(new ListCursor(docs), w, "csv", false, null, CancellationToken.None);
        var lines = w.ToString().Split('\n');
        Assert.Equal("_id,name,tags,at,extra", lines[0]);
        Assert.Equal("1,\"a,b\",\"[\"\"x\"\"]\",2024-01-02T03:04:05.000Z,", lines[1]);
        Assert.Equal("2,,,,true", lines[2]);
    }

    [Fact]
    public void Schema_counts_fields_types_and_array_elements()
    {
        var docs = new List<BsonDocument>
        {
            BsonDocument.Parse("{ a: 1, b: { c: 'x' }, t: [1, 'y', { k: 1 }] }"),
            BsonDocument.Parse("{ a: 'one', t: [] }"),
        };
        var f = Schema.Analyze(docs).ToDictionary(x => x.Path);
        Assert.Equal(2, f["a"].Count);
        Assert.Equal(1, f["a"].Types["int"]);
        Assert.Equal(1, f["a"].Types["string"]);
        Assert.Equal((1L, 2L), (f["b"].Count, f["b"].Of));
        Assert.Equal((1L, 1L), (f["b.c"].Count, f["b.c"].Of));
        Assert.Equal(3, f["t[]"].Count);
        Assert.Equal((1L, 1L), (f["t[].k"].Count, f["t[].k"].Of));
        Assert.Equal((0L, 3L), (f["t"].MinLength!.Value, f["t"].MaxLength!.Value));
        Assert.Equal(["a", "b", "b.c", "t", "t[]", "t[].k"], Schema.Analyze(docs).Select(x => x.Path).ToArray());
    }

    [Fact]
    public void Connection_string_passwords_are_kept_apart()
    {
        var (uri, pwd) = ConnectionManager.SplitPassword("mongodb://admin:s3cr%40t@db1:27017,db2:27017/shop?replicaSet=rs0");
        Assert.Equal("s3cr@t", pwd);
        Assert.DoesNotContain("s3cr", uri);
        Assert.Contains("admin@", uri);
        Assert.Contains("replicaSet=rs0", uri);
        Assert.Null(ConnectionManager.SplitPassword("mongodb://db1").Password);
    }

    [Fact]
    public void Server_selection_timeouts_are_shortened()
    {
        var msg = Api.ServerSelectionMessage("A timeout occurred after 1000ms selecting a server ... \"HeartbeatException\": \"MongoDB.Driver.MongoConnectionException: An exception occurred while opening a connection to the server.");
        Assert.StartsWith("The server didn't answer in time", msg);
        Assert.True(msg.Length < 300);
    }

    [Fact]
    public void Server_threads_and_idle_monitoring_are_background_operations()
    {
        Assert.True(Server.IsBackground(BsonDocument.Parse("{ desc: 'Checkpointer', op: 'none', isFromUserConnection: false, command: {} }")));
        Assert.True(Server.IsBackground(BsonDocument.Parse("{ op: 'command', command: { hello: 1, maxAwaitTimeMS: 10000, topologyVersion: {} } }")));
        Assert.False(Server.IsBackground(BsonDocument.Parse("{ op: 'command', command: { hello: 1 } }")));
        Assert.False(Server.IsBackground(BsonDocument.Parse("{ op: 'query', isFromUserConnection: true, command: { find: 'orders' } }")));
    }

    sealed class ListCursor(List<BsonDocument> docs) : MongoDB.Driver.IAsyncCursor<BsonDocument>
    {
        bool done;
        public IEnumerable<BsonDocument> Current => docs;
        public bool MoveNext(CancellationToken cancellationToken = default) { var r = !done; done = true; return r; }
        public Task<bool> MoveNextAsync(CancellationToken cancellationToken = default) => Task.FromResult(MoveNext(cancellationToken));
        public void Dispose() { }
    }
}
