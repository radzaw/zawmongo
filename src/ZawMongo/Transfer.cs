using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using MongoDB.Bson;
using MongoDB.Bson.IO;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Serializers;
using MongoDB.Driver;

namespace ZawMongo;

public sealed record ImportPreviewRequest(string FileId, string? Format = null, string? Delimiter = null, bool TypedCsv = true);
/// <summary>Mode: "insert" (duplicates are errors), "upsert" (replace documents with the same _id) or "skip" (keep existing).</summary>
public sealed record ImportRunRequest(string FileId, string Db, string Coll, string? Format = null, string? Delimiter = null, bool TypedCsv = true,
    string Mode = "insert", bool DropFirst = false, bool StopOnError = false);

/// <summary>Uploaded files waiting to be imported, in a temporary folder (deleted when the app stops).</summary>
public sealed class ImportStore : IAsyncDisposable
{
    public sealed record StoredFile(string Id, string Name, string Path, long Size);
    readonly ConcurrentDictionary<string, StoredFile> files = new();
    readonly string dir = Path.Combine(Path.GetTempPath(), "zawmongo-import-" + Environment.ProcessId);

    public async Task<StoredFile> SaveAsync(Stream body, string name, CancellationToken ct)
    {
        Directory.CreateDirectory(dir);
        var id = Guid.NewGuid().ToString("n");
        var path = Path.Combine(dir, id);
        await using (var fs = File.Create(path)) await body.CopyToAsync(fs, ct);
        var f = new StoredFile(id, Path.GetFileName(name), path, new FileInfo(path).Length);
        files[id] = f;
        return f;
    }

    public StoredFile Get(string id) => files.TryGetValue(id, out var f) ? f : throw new ApiException("The uploaded file is gone; choose it again.");

    public void Delete(string id)
    {
        if (files.TryRemove(id, out var f)) try { File.Delete(f.Path); } catch (IOException) { }
    }

    public ValueTask DisposeAsync()
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        return ValueTask.CompletedTask;
    }
}

/// <summary>Reads JSON / NDJSON / CSV files into documents, and writes documents out in the same formats.</summary>
public static class Transfer
{
    /// <summary>"json" (one array, or documents one after another, as mongoexport writes them) or "csv", from the name and content.</summary>
    public static string Detect(string name, string path)
    {
        var ext = Path.GetExtension(name).ToLowerInvariant();
        if (ext is ".csv" or ".tsv" or ".txt") return "csv";
        if (ext is ".json" or ".ndjson" or ".jsonl") return "json";
        using var r = new StreamReader(path, detectEncodingFromByteOrderMarks: true);
        int c;
        while ((c = r.Read()) >= 0 && char.IsWhiteSpace((char)c)) { }
        return c is '[' or '{' ? "json" : "csv";
    }

    /// <summary>Documents of a JSON file: an array of documents, or documents one after another (NDJSON). Extended JSON and shell syntax are understood.</summary>
    public static IEnumerable<BsonDocument> ReadJson(TextReader text)
    {
        using var reader = new JsonReader(text);
        var ctx = BsonDeserializationContext.CreateRoot(reader);
        if (reader.IsAtEndOfFile()) yield break;
        var type = reader.GetCurrentBsonType();
        if (type == BsonType.Array)
        {
            reader.ReadStartArray();
            while (reader.ReadBsonType() != BsonType.EndOfDocument)
            {
                if (reader.CurrentBsonType != BsonType.Document) throw new ApiException("The array holds something other than documents.");
                yield return BsonDocumentSerializer.Instance.Deserialize(ctx);
            }
            reader.ReadEndArray();
            yield break;
        }
        while (!reader.IsAtEndOfFile())
        {
            if (reader.GetCurrentBsonType() != BsonType.Document) throw new ApiException("Expected a document { … }.");
            yield return BsonDocumentSerializer.Instance.Deserialize(ctx);
        }
    }

    /// <summary>Splits CSV text into records (RFC 4180: quoted fields may hold delimiters, doubled quotes and line breaks).</summary>
    public static IEnumerable<List<string>> ReadCsvRecords(TextReader r, char delim)
    {
        var rec = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        var any = false;
        int c;
        while ((c = r.Read()) >= 0)
        {
            var ch = (char)c;
            any = true;
            if (quoted)
            {
                if (ch == '"')
                {
                    if (r.Peek() == '"') { r.Read(); field.Append('"'); }
                    else quoted = false;
                }
                else field.Append(ch);
                continue;
            }
            if (ch == '"' && field.Length == 0) { quoted = true; continue; }
            if (ch == delim) { rec.Add(field.ToString()); field.Clear(); continue; }
            if (ch is '\r' or '\n')
            {
                if (ch == '\r' && r.Peek() == '\n') r.Read();
                rec.Add(field.ToString());
                field.Clear();
                if (!(rec.Count == 1 && rec[0].Length == 0)) yield return rec;
                rec = [];
                any = false;
                continue;
            }
            field.Append(ch);
        }
        if (any || field.Length > 0)
        {
            rec.Add(field.ToString());
            if (!(rec.Count == 1 && rec[0].Length == 0)) yield return rec;
        }
    }

    /// <summary>The delimiter of a CSV file: the one of , ; tab | that splits its first line most.</summary>
    public static char DetectDelimiter(string firstLine)
    {
        char[] cands = [',', ';', '\t', '|'];
        return cands.OrderByDescending(d => firstLine.Count(ch => ch == d)).First();
    }

    /// <summary>A CSV cell as a BSON value: numbers, booleans and ISO dates typed when <paramref name="typed"/>; empty is missing (null).</summary>
    public static BsonValue? CsvValue(string s, bool typed)
    {
        if (s.Length == 0) return null;
        if (!typed) return s;
        if (s is "true" or "false") return s == "true";
        if (s == "null") return BsonNull.Value;
        // Codes with leading zeros ("007", zip codes) stay text, as do numbers that wouldn't survive the round trip.
        var lead = s.TrimStart('-');
        if (!(lead.Length > 1 && lead[0] == '0' && lead[1] != '.'))
        {
            if (int.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var i)) return i;
            if (long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var l)) return l;
            if (s.IndexOfAny(['.', 'e', 'E']) >= 0 && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d))
                return d;
        }
        if (s.Length >= 10 && char.IsAsciiDigit(s[0]) && s[4] == '-' && s[7] == '-'
            && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var dt))
            return new BsonDateTime(dt);
        return s;
    }

    /// <summary>Puts a value at a dotted path ("address.city"), creating the documents on the way.</summary>
    public static void SetPath(BsonDocument doc, string path, BsonValue value)
    {
        var parts = path.Split('.');
        var cur = doc;
        for (var i = 0; i < parts.Length - 1; i++)
        {
            if (!cur.TryGetValue(parts[i], out var next) || next is not BsonDocument nd)
            {
                nd = [];
                cur[parts[i]] = nd;
            }
            cur = nd;
        }
        cur[parts[^1]] = value;
    }

    public static IEnumerable<BsonDocument> ReadCsv(TextReader text, char? delimiter, bool typed)
    {
        // The delimiter is detected on the first line, which is then read again as a record.
        var first = text.ReadLine();
        if (first == null) yield break;
        var delim = delimiter ?? DetectDelimiter(first);
        var all = new StringReader(first + "\n");
        var header = ReadCsvRecords(all, delim).FirstOrDefault() ?? [];
        if (header.Count == 0 || header.All(h => h.Trim().Length == 0)) throw new ApiException("The first line must name the fields.");
        var names = header.Select((h, i) => h.Trim().Length == 0 ? $"field{i + 1}" : h.Trim()).ToList();
        foreach (var rec in ReadCsvRecords(text, delim))
        {
            var doc = new BsonDocument();
            for (var i = 0; i < names.Count && i < rec.Count; i++)
                if (CsvValue(rec[i], typed) is { } v) SetPath(doc, names[i], v);
            if (names[0] == "_id" && doc.TryGetValue("_id", out var id) && id is BsonString ids && ids.Value.Length == 24 && ObjectId.TryParse(ids.Value, out var oid))
                doc["_id"] = oid;
            yield return doc;
        }
    }

    static IEnumerable<BsonDocument> Read(ImportStore.StoredFile f, string? format, string? delimiter, bool typed, StreamReader r)
    {
        var fmt = format is "json" or "csv" ? format : Detect(f.Name, f.Path);
        char? delim = delimiter switch { null or "" or "auto" => null, "tab" or "\\t" => '\t', _ => delimiter[0] };
        return fmt == "csv" ? ReadCsv(r, delim, typed) : ReadJson(r);
    }

    public static object Preview(ImportStore store, ImportPreviewRequest req)
    {
        var f = store.Get(req.FileId);
        var format = req.Format is "json" or "csv" ? req.Format : Detect(f.Name, f.Path);
        using var r = new StreamReader(f.Path, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        try
        {
            var docs = Read(f, format, req.Delimiter, req.TypedCsv, r).Take(20).ToList();
            return new { format, docs = docs.Select(d => new BsonJson(d)).ToList(), name = f.Name, size = f.Size };
        }
        catch (Exception ex) when (ex is FormatException or BsonSerializationException or InvalidOperationException)
        {
            throw new ApiException($"The file can't be read as {format.ToUpperInvariant()}: {ex.Message}");
        }
    }

    /// <summary>Imports a file in batches of 1,000 documents. Returns the counts and the first errors.</summary>
    public static async Task<object> ImportAsync(DbSession s, ImportStore store, ImportRunRequest req, OpLog log, CancellationToken ct)
    {
        var f = store.Get(req.FileId);
        var db = s.Db(req.Db);
        var coll = db.GetCollection<BsonDocument>(req.Coll);
        if (req.DropFirst) await log.Timed($"{Shell.Ref(req.Db, req.Coll)}.drop()", async () => { await db.DropCollectionAsync(req.Coll, ct); return 0; });
        log.Note($"Importing {f.Name} into {req.Db}.{req.Coll} ({req.Mode})");
        long read = 0, inserted = 0, updated = 0, skipped = 0, failed = 0;
        var errors = new List<string>();
        var batch = new List<BsonDocument>(1000);
        var line = log.Add($"{Shell.Ref(req.Db, req.Coll)}.bulkWrite([ /* {f.Name} */ ], {{ ordered: {(req.StopOnError ? "true" : "false")} }})");

        async Task<bool> Flush()
        {
            if (batch.Count == 0) return true;
            var models = batch.Select(d => req.Mode switch
            {
                "upsert" when d.Contains("_id") => (WriteModel<BsonDocument>)new ReplaceOneModel<BsonDocument>(new BsonDocument("_id", d["_id"]), d) { IsUpsert = true },
                "skip" when d.Contains("_id") => new UpdateOneModel<BsonDocument>(new BsonDocument("_id", d["_id"]), new BsonDocument("$setOnInsert", d)) { IsUpsert = true },
                _ => new InsertOneModel<BsonDocument>(d),
            }).ToList();
            var first = read - batch.Count;
            batch.Clear();
            try
            {
                var r = await coll.BulkWriteAsync(models, new BulkWriteOptions { IsOrdered = req.StopOnError }, ct);
                Count(r);
                return true;
            }
            catch (MongoBulkWriteException<BsonDocument> ex)
            {
                Count(ex.Result);
                failed += ex.WriteErrors.Count;
                foreach (var e in ex.WriteErrors.Take(Math.Max(0, 50 - errors.Count)))
                    errors.Add($"Document {first + e.Index + 1}: {e.Message}");
                return !req.StopOnError;
            }
        }
        void Count(BulkWriteResult<BsonDocument> r)
        {
            if (!r.IsAcknowledged) return;
            inserted += r.InsertedCount + r.Upserts.Count;
            updated += req.Mode == "upsert" ? r.MatchedCount : 0;
            skipped += req.Mode == "skip" ? r.MatchedCount : 0;
        }

        try
        {
            using var reader = new StreamReader(f.Path, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            foreach (var d in Read(f, req.Format, req.Delimiter, req.TypedCsv, reader))
            {
                read++;
                batch.Add(d);
                if (batch.Count >= 1000 && !await Flush()) break;
            }
            await Flush();
        }
        catch (Exception ex) when (ex is FormatException or BsonSerializationException or InvalidOperationException)
        {
            errors.Add($"After document {read}: the file can't be read further: {ex.Message}");
        }
        finally { log.Finish(line); }
        log.Note($"Import finished: {read} read, {inserted} inserted, {updated} replaced, {skipped} skipped, {failed} failed");
        return new { read, inserted, updated, skipped, failed, errors };
    }

    // ---------------------------------------------------------------- export

    /// <summary>
    /// Writes documents as a JSON array (relaxed or canonical Extended JSON), as NDJSON (one document per line, as
    /// mongoexport does) or as CSV with the given (or the first documents') top-level fields.
    /// </summary>
    public static async Task WriteAsync(IAsyncCursor<BsonDocument> cursor, TextWriter w, string format, bool canonical, List<string>? fields, CancellationToken ct)
    {
        var settings = new JsonWriterSettings { OutputMode = canonical ? JsonOutputMode.CanonicalExtendedJson : JsonOutputMode.RelaxedExtendedJson, Indent = format == "json" };
        if (format == "csv")
        {
            // Without a field list, the columns come from the first 1,000 documents.
            var cols = fields is { Count: > 0 } ? fields : null;
            var pending = new List<BsonDocument>();
            if (cols != null) await WriteCsvHeader(w, cols);
            using (cursor)
            {
                while (await cursor.MoveNextAsync(ct))
                {
                    foreach (var d in cursor.Current)
                    {
                        if (cols != null) { await WriteCsvRow(w, d, cols); continue; }
                        pending.Add(d);
                        if (pending.Count < 1000) continue;
                        cols = ColumnsOf(pending);
                        await WriteCsvHeader(w, cols);
                        foreach (var p in pending) await WriteCsvRow(w, p, cols);
                    }
                }
            }
            if (cols == null)
            {
                cols = ColumnsOf(pending);
                await WriteCsvHeader(w, cols);
                foreach (var p in pending) await WriteCsvRow(w, p, cols);
            }
            return;
        }
        var firstDoc = true;
        if (format == "json") await w.WriteAsync("[\n");
        using (cursor)
        {
            while (await cursor.MoveNextAsync(ct))
            {
                foreach (var d in cursor.Current)
                {
                    if (format == "json" && !firstDoc) await w.WriteAsync(",\n");
                    var json = d.ToJson(settings);
                    await w.WriteAsync(format == "json" ? json : json.Replace('\n', ' '));
                    if (format != "json") await w.WriteAsync('\n');
                    firstDoc = false;
                }
            }
        }
        if (format == "json") await w.WriteAsync("\n]\n");
    }

    /// <summary>The top-level fields of some documents, in first-seen order (_id first).</summary>
    public static List<string> ColumnsOf(IEnumerable<BsonDocument> docs)
    {
        var cols = new List<string>();
        var seen = new HashSet<string>();
        foreach (var d in docs)
            foreach (var n in d.Names)
                if (seen.Add(n)) cols.Add(n);
        var id = cols.IndexOf("_id");
        if (id > 0) { cols.RemoveAt(id); cols.Insert(0, "_id"); }
        return cols;
    }

    static Task WriteCsvHeader(TextWriter w, List<string> cols) => w.WriteAsync(string.Join(',', cols.Select(CsvQuote)) + "\n");

    static Task WriteCsvRow(TextWriter w, BsonDocument d, List<string> cols) =>
        w.WriteAsync(string.Join(',', cols.Select(c => CsvQuote(CsvText(Lookup(d, c))))) + "\n");

    static BsonValue? Lookup(BsonDocument d, string path)
    {
        BsonValue cur = d;
        foreach (var p in path.Split('.'))
            if (cur is not BsonDocument doc || !doc.TryGetValue(p, out cur)) return null;
        return cur;
    }

    static readonly JsonWriterSettings Relaxed = new() { OutputMode = JsonOutputMode.RelaxedExtendedJson };

    /// <summary>A value as CSV text: plain for strings, numbers, dates and ids; Extended JSON for documents and arrays.</summary>
    public static string CsvText(BsonValue? v) => v switch
    {
        null or BsonNull => "",
        BsonString s => s.Value,
        BsonObjectId o => o.Value.ToString(),
        BsonDateTime dt => dt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        BsonBoolean b => b.Value ? "true" : "false",
        BsonInt32 or BsonInt64 => v.ToString()!,
        BsonDouble d => d.Value.ToString("R", CultureInfo.InvariantCulture),
        BsonDecimal128 m => m.Value.ToString(),
        _ => new BsonDocument("v", v).ToJson(Relaxed) is var j ? j[(j.IndexOf(':') + 1)..j.LastIndexOf('}')].Trim() : "",
    };

    static string CsvQuote(string s) => s.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;
}
