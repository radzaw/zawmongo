using MongoDB.Bson;
using MongoDB.Driver;

namespace ZawMongo;

/// <summary>A field seen in sampled documents: where, how often, with which types and example values.</summary>
public sealed class FieldStats
{
    public required string Path { get; init; }
    public int Depth { get; init; }
    /// <summary>How many sampled documents (or array elements, for paths inside arrays) have the field.</summary>
    public long Count { get; set; }
    /// <summary>Documents it could have appeared in: the parent's count.</summary>
    public long Of { get; set; }
    public Dictionary<string, long> Types { get; } = [];
    public List<BsonJson> Examples { get; } = [];
    readonly HashSet<string> seen = [];
    public long? MinLength { get; set; }
    public long? MaxLength { get; set; }

    internal void Example(BsonValue v)
    {
        if (Examples.Count >= 5 || v is BsonDocument or BsonArray) return;
        var key = v.ToString() ?? "";
        if (key.Length > 200 || !seen.Add(key)) return;
        Examples.Add(new BsonJson(v));
    }
}

/// <summary>Infers the shape of a collection from a random sample of its documents (Collection tab › Schema).</summary>
public static class Schema
{
    public static string TypeName(BsonValue v) => v.BsonType switch
    {
        BsonType.Double => "double",
        BsonType.String => "string",
        BsonType.Document => "object",
        BsonType.Array => "array",
        BsonType.Binary => v.AsBsonBinaryData.SubType is BsonBinarySubType.UuidStandard or BsonBinarySubType.UuidLegacy ? "uuid" : "binData",
        BsonType.ObjectId => "objectId",
        BsonType.Boolean => "bool",
        BsonType.DateTime => "date",
        BsonType.Null => "null",
        BsonType.RegularExpression => "regex",
        BsonType.JavaScript or BsonType.JavaScriptWithScope => "javascript",
        BsonType.Int32 => "int",
        BsonType.Timestamp => "timestamp",
        BsonType.Int64 => "long",
        BsonType.Decimal128 => "decimal",
        BsonType.MinKey => "minKey",
        BsonType.MaxKey => "maxKey",
        BsonType.Undefined => "undefined",
        _ => v.BsonType.ToString(),
    };

    /// <summary>Field statistics over <paramref name="docs"/>, in first-seen order with children after their parent.</summary>
    public static List<FieldStats> Analyze(IReadOnlyList<BsonDocument> docs)
    {
        var fields = new Dictionary<string, FieldStats>();
        var order = new List<string>();
        void Visit(BsonDocument d, string prefix, int depth)
        {
            foreach (var e in d.Elements)
            {
                var path = prefix.Length == 0 ? e.Name : prefix + "." + e.Name;
                if (!fields.TryGetValue(path, out var f))
                {
                    f = new FieldStats { Path = path, Depth = depth };
                    fields[path] = f;
                    order.Add(path);
                }
                f.Count++;
                Count(f, e.Value);
                switch (e.Value)
                {
                    case BsonDocument sub:
                        Visit(sub, path, depth + 1);
                        break;
                    case BsonArray arr:
                        f.MinLength = f.MinLength is { } mn ? Math.Min(mn, arr.Count) : arr.Count;
                        f.MaxLength = f.MaxLength is { } mx ? Math.Max(mx, arr.Count) : arr.Count;
                        // Elements count as "path[]": their types, and the fields of element documents below it.
                        var el = path + "[]";
                        if (!fields.TryGetValue(el, out var ef))
                        {
                            ef = new FieldStats { Path = el, Depth = depth + 1 };
                            fields[el] = ef;
                            order.Add(el);
                        }
                        foreach (var item in arr)
                        {
                            ef.Count++;
                            Count(ef, item);
                            if (item is BsonDocument idoc) Visit(idoc, el, depth + 2);
                        }
                        break;
                }
            }
        }
        foreach (var d in docs) Visit(d, "", 0);

        // "Of": how many documents or elements the field could have been in.
        foreach (var f in fields.Values)
        {
            var cut = Parent(f.Path);
            // Below an object field (or array elements), only the objects among the parent's values count.
            f.Of = f.Path.EndsWith("[]", StringComparison.Ordinal) ? f.Count
                : cut == null ? docs.Count
                : fields.TryGetValue(cut, out var p) ? p.Types.GetValueOrDefault("object") : docs.Count;
        }
        // Children right after their parent, keeping the order fields were first seen in.
        var result = new List<FieldStats>();
        void Add(string? parent)
        {
            foreach (var p in order.Where(o => Parent(o) == parent))
            {
                result.Add(fields[p]);
                Add(p);
            }
        }
        Add(null);
        return result;
    }

    /// <summary>"a.b" → "a"; "a[]" → "a"; "a[].b" → "a[]"; top level → null.</summary>
    public static string? Parent(string path)
    {
        if (path.EndsWith("[]", StringComparison.Ordinal)) return path[..^2];
        var dot = path.LastIndexOf('.');
        return dot < 0 ? null : path[..dot];
    }

    static void Count(FieldStats f, BsonValue v)
    {
        var t = TypeName(v);
        f.Types[t] = f.Types.GetValueOrDefault(t) + 1;
        f.Example(v);
    }

    public static async Task<object> SampleAsync(DbSession s, string db, string coll, int size, string? filter, OpLog log, CancellationToken ct)
    {
        size = Math.Clamp(size, 1, 10_000);
        var match = Shell.ParseDocument(filter, "filter");
        var pipeline = new List<BsonDocument>();
        if (match.ElementCount > 0) pipeline.Add(new BsonDocument("$match", match));
        pipeline.Add(new BsonDocument("$sample", new BsonDocument("size", size)));
        var c = s.Coll(db, coll);
        var docs = await log.Timed($"{Shell.Ref(db, coll)}.aggregate({Shell.Show(new BsonArray(pipeline))})", async () =>
            await (await c.AggregateAsync<BsonDocument>(pipeline, new AggregateOptions { AllowDiskUse = true }, ct)).ToListAsync(ct));
        var fields = Analyze(docs);
        return new
        {
            sampled = docs.Count,
            fields = fields.Select(f => new
            {
                path = f.Path,
                depth = f.Depth,
                count = f.Count,
                of = f.Of,
                types = f.Types.OrderByDescending(t => t.Value).Select(t => new { type = t.Key, count = t.Value }).ToList(),
                examples = f.Examples,
                minLength = f.MinLength,
                maxLength = f.MaxLength,
            }).ToList(),
        };
    }
}
