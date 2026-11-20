using System.Text.Json;
using System.Text.Json.Serialization;
using MongoDB.Bson;
using MongoDB.Bson.IO;

namespace ZawMongo;

/// <summary>
/// A BSON value in an API response, written as canonical Extended JSON ({"$oid": …}, {"$numberLong": …}): the page
/// sees every type exactly, so values it sends back unchanged keep their type.
/// </summary>
[JsonConverter(typeof(BsonJsonConverter))]
public sealed record BsonJson(BsonValue Value);

public sealed class BsonJsonConverter : JsonConverter<BsonJson>
{
    public static readonly JsonWriterSettings Canonical = new() { OutputMode = JsonOutputMode.CanonicalExtendedJson, Indent = false };

    public override BsonJson Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        return new BsonJson(Ejson.Parse(doc.RootElement.GetRawText()));
    }

    public override void Write(Utf8JsonWriter writer, BsonJson value, JsonSerializerOptions options) =>
        writer.WriteRawValue(Ejson.Write(value.Value), skipInputValidation: true);
}

public static class Ejson
{
    /// <summary>A value as canonical Extended JSON.</summary>
    public static string Write(BsonValue v)
    {
        // The writer needs a document around a single value.
        var json = new BsonDocument("v", v).ToJson(BsonJsonConverter.Canonical);
        var start = json.IndexOf(':') + 1;
        return json[start..json.LastIndexOf('}')].Trim();
    }

    /// <summary>Reads Extended JSON (canonical or relaxed) or shell syntax.</summary>
    public static BsonValue Parse(string json) => BsonDocument.Parse("{\"v\":" + json + "\n}")["v"];
}
