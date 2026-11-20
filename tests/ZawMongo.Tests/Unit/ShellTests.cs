using MongoDB.Bson;

namespace ZawMongo.Tests.Unit;

public class ShellTests
{
    [Fact]
    public void Splits_on_semicolons_and_complete_lines()
    {
        var s = Shell.Split("""
            use shop
            db.orders.find({ status: 'open' })
              .sort({ at: -1 })
              .limit(5);  db.orders.countDocuments({})
            // a comment line
            db.orders.insertOne({
              a: 1,
            })
            """);
        Assert.Equal(["use shop", "db.orders.find({ status: 'open' })\n  .sort({ at: -1 })\n  .limit(5)", "db.orders.countDocuments({})", "db.orders.insertOne({\n  a: 1,\n})"],
            s.Select(x => x.Text.Replace("\r", "")).ToArray());
    }

    [Fact]
    public void Semicolons_and_newlines_inside_strings_and_regexes_do_not_split()
    {
        var s = Shell.Split("db.c.find({ a: 'x;y', b: /;\\//i })\ndb.c.find({ c: \"line\\n;\" })");
        Assert.Equal(2, s.Count);
        Assert.Equal("db.c.find({ a: 'x;y', b: /;\\//i })", s[0].Text);
    }

    [Fact]
    public void Parses_a_find_with_cursor_modifiers()
    {
        var c = Shell.Parse("db.orders.find({ total: { $gt: 10 } }, { _id: 0 }).sort({ total: -1 }).skip(5).limit(10)");
        Assert.Equal(ShellKind.Collection, c.Kind);
        Assert.Equal("orders", c.Collection);
        Assert.Equal("find", c.Method);
        Assert.Equal(BsonDocument.Parse("{ total: { $gt: 10 } }"), c.Args[0]);
        Assert.Equal(["sort", "skip", "limit"], c.Chain.Select(x => x.Name).ToArray());
        Assert.Equal(10, c.Find("limit")!.Args[0].AsInt32);
    }

    [Fact]
    public void Collection_names_can_be_dotted_quoted_or_on_another_database()
    {
        Assert.Equal("system.profile", Shell.Parse("db.system.profile.find()").Collection);
        Assert.Equal("my-coll", Shell.Parse("db['my-coll'].find()").Collection);
        Assert.Equal("my coll", Shell.Parse("db.getCollection(\"my coll\").countDocuments({})").Collection);
        var c = Shell.Parse("db.getSiblingDB('admin').system.users.find()");
        Assert.Equal("admin", c.Database);
        Assert.Equal("system.users", c.Collection);
    }

    [Fact]
    public void Database_methods_use_and_show()
    {
        var c = Shell.Parse("db.runCommand({ ping: 1 })");
        Assert.Equal(ShellKind.Db, c.Kind);
        Assert.Equal("runCommand", c.Method);
        Assert.Equal(ShellKind.Use, Shell.Parse("use shop;").Kind);
        Assert.Equal("shop", Shell.Parse("use shop").Arg);
        var show = Shell.Parse("show collections");
        Assert.Equal((ShellKind.Show, "collections"), (show.Kind, show.Method));
    }

    [Fact]
    public void Explain_before_or_after_the_call()
    {
        Assert.Equal("executionStats", Shell.Parse("db.c.explain('executionStats').find({ a: 1 })").Explain);
        var c = Shell.Parse("db.c.find({ a: 1 }).explain(true)");
        Assert.Equal("allPlansExecution", Shell.Verbosity(c.Find("explain")!.Args));
    }

    [Fact]
    public void Shell_literals_are_understood()
    {
        var a = Shell.ParseArgs("{ id: ObjectId(), at: ISODate(), n: NumberLong(5), d: NumberDecimal('1.50'), x: .5, y: +3, r: /ab+c/i, s: `plain` } // trailing");
        var d = a[0].AsBsonDocument;
        Assert.Equal(BsonType.ObjectId, d["id"].BsonType);
        Assert.Equal(BsonType.DateTime, d["at"].BsonType);
        Assert.Equal(BsonType.Int64, d["n"].BsonType);
        Assert.Equal(BsonType.Decimal128, d["d"].BsonType);
        Assert.Equal(0.5, d["x"].AsDouble);
        Assert.Equal(3, d["y"].AsInt32);
        Assert.Equal("ab+c", d["r"].AsBsonRegularExpression.Pattern);
        Assert.Equal("plain", d["s"].AsString);
    }

    [Theory]
    [InlineData("var x = 1")]
    [InlineData("db.c.find(x)")]
    [InlineData("db.c.find({ a: `${x}` })")]
    [InlineData("db.c")]
    [InlineData("db.c.find({ a: 1 }")]
    public void Javascript_and_broken_statements_are_refused(string text)
    {
        Assert.Throws<ApiException>(() => Shell.Parse(text));
    }

    [Fact]
    public void Show_writes_compact_shell_syntax()
    {
        var d = BsonDocument.Parse("{ name: 'x', 'a b': 1, n: NumberLong(2) }");
        Assert.Equal("{ name: \"x\", \"a b\": 1, n: NumberLong(2) }", Shell.Show(d));
        Assert.Equal("db.getSiblingDB(\"shop\").orders", Shell.Ref("shop", "orders"));
        Assert.Equal("db.getSiblingDB(\"shop\").getCollection(\"a-b\")", Shell.Ref("shop", "a-b"));
    }

    [Fact]
    public void Ejson_keeps_every_type()
    {
        var d = BsonDocument.Parse("{ i: 1, l: NumberLong(1), f: 1.0, s: 'x', o: ObjectId('5f1d7f3b9d1e8a0001a1b2c3') }");
        var json = Ejson.Write(d);
        Assert.Contains("$numberLong", json);
        Assert.Equal(d, Ejson.Parse(json));
        Assert.Equal("{ \"$numberInt\" : \"7\" }", Ejson.Write(7));
    }
}
