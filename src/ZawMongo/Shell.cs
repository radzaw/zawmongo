using System.Text;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;

namespace ZawMongo;

public enum ShellKind { Use, Show, Db, Collection }

/// <summary>A call in a chain: <c>.sort({ a: 1 })</c>.</summary>
public sealed record ShellCall(string Name, BsonArray Args);

/// <summary>
/// One shell statement, parsed: <c>use x</c>, <c>show dbs</c>, <c>db.method(...)</c> or
/// <c>db.coll.method(...).cursorMethod(...)</c>. Arguments are literals in shell syntax (JSON with unquoted keys, single
/// quotes, ObjectId(), ISODate(), NumberLong(), regular expressions …), not JavaScript.
/// </summary>
public sealed class ShellCommand
{
    public required string Text { get; init; }
    public required ShellKind Kind { get; init; }
    /// <summary>The database named with getSiblingDB/getDB; null for the current one.</summary>
    public string? Database { get; init; }
    public string? Collection { get; init; }
    /// <summary>The main call ("find", "runCommand"), or the word after use/show.</summary>
    public required string Method { get; init; }
    public BsonArray Args { get; init; } = [];
    /// <summary>Calls chained after the main one (cursor modifiers such as sort, limit, explain).</summary>
    public List<ShellCall> Chain { get; init; } = [];
    /// <summary>Set for <c>db.coll.explain("executionStats").find(...)</c>: the verbosity.</summary>
    public string? Explain { get; init; }
    /// <summary>The argument of show (show collections, show profile …), when it has one.</summary>
    public string? Arg { get; init; }

    public BsonValue? ArgAt(int i) => i < Args.Count ? Args[i] : null;
    public BsonDocument? DocAt(int i, string what) => ArgAt(i) switch
    {
        null or BsonNull => null,
        BsonDocument d => d,
        _ => throw new ApiException($"{Method}: the {what} must be a document."),
    };
    public ShellCall? Find(string name) => Chain.LastOrDefault(c => c.Name == name);
}

/// <summary>A piece of a script: the statement's text and where it is (character offsets).</summary>
public sealed record ShellStatement(string Text, int Start, int End);

/// <summary>Reads mongosh-style statements. Shared by the query tabs and the tests.</summary>
public static class Shell
{
    enum T { Ident, Str, Num, Regex, Punct, Comment, Space, Newline }
    readonly record struct Tok(T Type, int Start, int End);

    /// <summary>Tokens of shell text; never fails (an unterminated string runs to the end).</summary>
    static List<Tok> Lex(string s)
    {
        var list = new List<Tok>();
        var i = 0;
        while (i < s.Length)
        {
            var c = s[i];
            var start = i;
            if (c == '\n') { i++; list.Add(new(T.Newline, start, i)); continue; }
            if (char.IsWhiteSpace(c)) { while (i < s.Length && s[i] != '\n' && char.IsWhiteSpace(s[i])) i++; list.Add(new(T.Space, start, i)); continue; }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '/') { while (i < s.Length && s[i] != '\n') i++; list.Add(new(T.Comment, start, i)); continue; }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '*')
            {
                var e = s.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = e < 0 ? s.Length : e + 2;
                list.Add(new(T.Comment, start, i));
                continue;
            }
            if (c is '"' or '\'' or '`')
            {
                i++;
                while (i < s.Length && s[i] != c) i += s[i] == '\\' ? 2 : 1;
                i = Math.Min(s.Length, i + 1);
                list.Add(new(T.Str, start, i));
                continue;
            }
            if (c == '/' && RegexAllowed(s, list))
            {
                i++;
                var cls = false;
                while (i < s.Length && s[i] != '\n' && (s[i] != '/' || cls))
                {
                    if (s[i] == '\\') i++;
                    else if (s[i] == '[') cls = true;
                    else if (s[i] == ']') cls = false;
                    i++;
                }
                i = Math.Min(s.Length, i + 1);
                while (i < s.Length && char.IsAsciiLetter(s[i])) i++;
                list.Add(new(T.Regex, start, i));
                continue;
            }
            if (char.IsAsciiDigit(c) || (c == '.' && i + 1 < s.Length && char.IsAsciiDigit(s[i + 1]) && !AfterValue(s, list)))
            {
                while (i < s.Length && (char.IsAsciiLetterOrDigit(s[i]) || s[i] == '.' || ((s[i] is '+' or '-') && s[i - 1] is 'e' or 'E'))) i++;
                list.Add(new(T.Num, start, i));
                continue;
            }
            if (char.IsLetter(c) || c is '_' or '$')
            {
                while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] is '_' or '$')) i++;
                list.Add(new(T.Ident, start, i));
                continue;
            }
            i++;
            list.Add(new(T.Punct, start, i));
        }
        return list;
    }

    static Tok? LastSignificant(List<Tok> list)
    {
        for (var k = list.Count - 1; k >= 0; k--)
            if (list[k].Type is not (T.Space or T.Newline or T.Comment)) return list[k];
        return null;
    }

    /// <summary>A '/' starts a regular expression where a value is expected (not after a value: that's division).</summary>
    static bool RegexAllowed(string s, List<Tok> list) => !AfterValue(s, list);

    static bool AfterValue(string s, List<Tok> list)
    {
        var prev = LastSignificant(list);
        if (prev is not { } p) return false;
        return p.Type is T.Ident or T.Str or T.Num or T.Regex || (p.Type == T.Punct && s[p.Start] is ')' or ']' or '}');
    }

    /// <summary>
    /// Splits a script into statements: at a semicolon, or at a line break where the statement is complete (brackets
    /// closed, and the next line doesn't continue it with ".sort(…)" and the like).
    /// </summary>
    public static List<ShellStatement> Split(string script)
    {
        var toks = Lex(script);
        var result = new List<ShellStatement>();
        var depth = 0;
        int? start = null;
        var end = 0;
        void Flush()
        {
            if (start is { } st && end > st) result.Add(new(script[st..end], st, end));
            start = null;
        }
        for (var k = 0; k < toks.Count; k++)
        {
            var t = toks[k];
            if (t.Type is T.Space or T.Comment) continue;
            if (t.Type == T.Newline)
            {
                if (depth > 0 || start == null) continue;
                // A line ending in an operator or a dot, or a next line starting with one, continues the statement.
                var last = script[end - 1];
                if (last is '.' or ',' or '(' or '[' or '{' or ':' or '+' or '-' or '=' or '&' or '|' or '?') continue;
                var next = toks.Skip(k + 1).FirstOrDefault(x => x.Type is not (T.Space or T.Newline or T.Comment));
                if (next.End > next.Start && next.Type == T.Punct && script[next.Start] is '.' or ')' or ']' or '}' or ',') continue;
                Flush();
                continue;
            }
            if (t.Type == T.Punct)
            {
                var ch = script[t.Start];
                if (ch is '(' or '[' or '{') depth++;
                else if (ch is ')' or ']' or '}') depth = Math.Max(0, depth - 1);
                else if (ch == ';' && depth == 0) { Flush(); continue; }
            }
            start ??= t.Start;
            end = t.End;
        }
        Flush();
        return result;
    }

    /// <summary>
    /// Rewrites argument text into what the BSON shell-syntax reader accepts: comments removed, ObjectId() and
    /// ISODate() without arguments made explicit, ".5" and "+5" written as plain numbers.
    /// </summary>
    public static string Normalize(string text)
    {
        var toks = Lex(text);
        var sb = new StringBuilder(text.Length + 16);
        for (var k = 0; k < toks.Count; k++)
        {
            var t = toks[k];
            var s = text[t.Start..t.End];
            switch (t.Type)
            {
                case T.Comment:
                    sb.Append(' ');
                    continue;
                case T.Num when s.StartsWith('.'):
                    sb.Append('0').Append(s);
                    continue;
                case T.Ident when (s is "ObjectId" or "ISODate") && IsEmptyCall(text, toks, k, out var close):
                    sb.Append(s == "ObjectId" ? $"ObjectId(\"{ObjectId.GenerateNewId()}\")" : "new Date()");
                    k = close;
                    continue;
                case T.Str when s.StartsWith('`'):
                    // A template literal without substitutions is a plain string.
                    if (s.Contains("${", StringComparison.Ordinal)) throw new ApiException("Template strings with ${…} are not supported; arguments must be literal values.");
                    sb.Append('"').Append(s[1..^1].Replace("\"", "\\\"")).Append('"');
                    continue;
                case T.Punct when text[t.Start] == '+' && NextIsNumber(toks, k):
                    continue;
                default:
                    sb.Append(s);
                    continue;
            }
        }
        return sb.ToString();
    }

    static bool NextIsNumber(List<Tok> toks, int k) => k + 1 < toks.Count && toks[k + 1].Type == T.Num;

    static bool IsEmptyCall(string text, List<Tok> toks, int k, out int close)
    {
        close = k;
        var j = k + 1;
        while (j < toks.Count && toks[j].Type is T.Space or T.Comment) j++;
        if (j >= toks.Count || text[toks[j].Start] != '(') return false;
        j++;
        while (j < toks.Count && toks[j].Type is T.Space or T.Comment or T.Newline) j++;
        if (j >= toks.Count || text[toks[j].Start] != ')') return false;
        close = j;
        return true;
    }

    /// <summary>Parses a comma separated argument list (the text between a call's parentheses).</summary>
    public static BsonArray ParseArgs(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        try
        {
            return BsonSerializer.Deserialize<BsonArray>("[" + Normalize(text) + "\n]");
        }
        catch (Exception ex) when (ex is FormatException or MongoDB.Bson.BsonSerializationException or InvalidOperationException or ArgumentException)
        {
            throw new ApiException($"Cannot read the arguments: {ex.Message} Arguments must be literal values in shell syntax (variables and functions are not supported).");
        }
    }

    /// <summary>Parses a document in shell syntax ("{ name: 'x', at: ISODate() }"); empty text is an empty document.</summary>
    public static BsonDocument ParseDocument(string? text, string what = "document")
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        var args = ParseArgs(text);
        if (args.Count != 1 || args[0] is not BsonDocument d) throw new ApiException($"The {what} must be one document: {{ … }}.");
        return d;
    }

    /// <summary>Parses an aggregation pipeline: an array of stages.</summary>
    public static BsonArray ParsePipeline(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        var args = ParseArgs(text);
        if (args.Count != 1 || args[0] is not BsonArray a || a.Any(s => s is not BsonDocument)) throw new ApiException("The pipeline must be an array of stages: [ { $match: … }, … ].");
        return a;
    }

    /// <summary>Parses one value in shell syntax ("42", "'text'", "ObjectId('…')", "{ a: 1 }").</summary>
    public static BsonValue ParseValue(string text)
    {
        var args = ParseArgs(text);
        if (args.Count != 1) throw new ApiException("Enter exactly one value.");
        return args[0];
    }

    // ---------------------------------------------------------------- statements

    static readonly HashSet<string> DbMethods =
    [
        "runCommand", "adminCommand", "getCollectionNames", "getCollectionInfos", "stats", "createCollection", "createView",
        "dropDatabase", "getName", "version", "serverStatus", "hostInfo", "serverBuildInfo", "currentOp", "killOp", "getUsers", "getUser",
        "createUser", "dropUser", "updateUser", "grantRolesToUser", "revokeRolesFromUser", "getRoles", "getRole", "aggregate",
        "getProfilingStatus", "setProfilingLevel", "listCommands", "isMaster", "hello",
    ];

    /// <summary>Parses one statement.</summary>
    public static ShellCommand Parse(string statement)
    {
        var text = statement.Trim().TrimEnd(';').Trim();
        var toks = Lex(text).Where(t => t.Type is not (T.Space or T.Newline or T.Comment)).ToList();
        if (toks.Count == 0) throw new ApiException("Empty statement.");
        string W(int k) => k < toks.Count ? text[toks[k].Start..toks[k].End] : "";

        if (W(0) is "use" && toks.Count >= 2 && toks[1].Type != T.Punct)
        {
            var name = Unquote(text[toks[1].Start..].Trim());
            return new ShellCommand { Text = text, Kind = ShellKind.Use, Method = "use", Arg = name };
        }
        if (W(0) is "show" && toks.Count >= 2 && toks[1].Type == T.Ident)
            return new ShellCommand { Text = text, Kind = ShellKind.Show, Method = W(1), Arg = toks.Count > 2 ? Unquote(text[toks[2].Start..].Trim()) : null };
        if (W(0) != "db")
            throw new ApiException("Statements start with db, use or show (for example db.users.find({ age: { $gt: 30 } })). JavaScript such as variables, functions and loops is not supported.");

        // The chain after "db": members (.name, ["name"]) and calls (.name(args)).
        var segs = new List<(string Name, string? Args)>();
        var k = 1;
        while (k < toks.Count)
        {
            var c = text[toks[k].Start];
            string name;
            if (c == '.' && k + 1 < toks.Count && toks[k + 1].Type == T.Ident) { name = W(k + 1); k += 2; }
            else if (c == '[' && k + 2 < toks.Count && toks[k + 1].Type == T.Str && text[toks[k + 2].Start] == ']') { name = Unquote(W(k + 1)); k += 3; }
            else throw new ApiException($"Unexpected \"{W(k)}\" at position {toks[k].Start + 1}.");
            if (k < toks.Count && text[toks[k].Start] == '(')
            {
                var close = MatchParen(text, toks, k);
                segs.Add((name, text[toks[k].End..toks[close].Start]));
                k = close + 1;
            }
            else segs.Add((name, null));
        }
        if (segs.Count == 0) throw new ApiException("Incomplete statement: db.<collection>.<method>(…) or db.<method>(…).");

        var i = 0;
        string? database = null;
        if (segs[0] is ("getSiblingDB" or "getDB", { } dbArg))
        {
            database = StringArg(dbArg, segs[0].Name);
            i = 1;
        }
        else if (segs[0] is ("getMongo", "") && segs.Count > 1 && segs[1] is ("getDB", { } a2))
        {
            database = StringArg(a2, "getDB");
            i = 2;
        }
        if (i >= segs.Count) throw new ApiException("Incomplete statement: add .<collection>.<method>(…) or .<method>(…).");

        string? coll = null;
        if (segs[i] is ("getCollection", { } cArg))
        {
            coll = StringArg(cArg, "getCollection");
            i++;
        }
        else if (segs[i].Args != null && DbMethods.Contains(segs[i].Name))
        {
            return new ShellCommand
            {
                Text = text, Kind = ShellKind.Db, Database = database, Method = segs[i].Name, Args = ParseArgs(segs[i].Args!),
                Chain = segs.Skip(i + 1).Select(s => new ShellCall(s.Name, s.Args == null ? throw new ApiException($"Unexpected .{s.Name}") : ParseArgs(s.Args))).ToList(),
            };
        }
        else
        {
            // Collection names may contain dots: db.system.profile.find()
            var parts = new List<string>();
            while (i < segs.Count && segs[i].Args == null) parts.Add(segs[i++].Name);
            if (parts.Count == 0) throw new ApiException($"Unknown database method: db.{segs[i].Name}().");
            coll = string.Join('.', parts);
        }
        if (i >= segs.Count) throw new ApiException($"Add a method: db.{coll}.find(), .aggregate([…]), .insertOne({{…}}) …");
        if (segs[i].Args == null) throw new ApiException($"Expected a method call after {coll}.");

        string? explain = null;
        if (segs[i].Name == "explain")
        {
            var ea = ParseArgs(segs[i].Args!);
            explain = Verbosity(ea);
            i++;
            if (i >= segs.Count || segs[i].Args == null) throw new ApiException("explain() needs a following call: db.coll.explain().find({…}).");
        }
        var method = segs[i].Name;
        var args = ParseArgs(segs[i].Args!);
        var chain = new List<ShellCall>();
        foreach (var s in segs.Skip(i + 1))
        {
            if (s.Args == null) throw new ApiException($"Unexpected .{s.Name} (a call needs parentheses).");
            chain.Add(new ShellCall(s.Name, ParseArgs(s.Args)));
        }
        return new ShellCommand { Text = text, Kind = ShellKind.Collection, Database = database, Collection = coll, Method = method, Args = args, Chain = chain, Explain = explain };
    }

    /// <summary>The verbosity of explain()'s argument: a mode name, or true for allPlansExecution.</summary>
    public static string Verbosity(BsonArray args) => args.Count == 0 ? "queryPlanner"
        : args[0] is BsonString s && s.Value is "queryPlanner" or "executionStats" or "allPlansExecution" ? s.Value
        : args[0] is BsonBoolean b ? (b.Value ? "allPlansExecution" : "queryPlanner")
        : throw new ApiException("explain() takes \"queryPlanner\", \"executionStats\" or \"allPlansExecution\".");

    static string StringArg(string args, string method)
    {
        var a = ParseArgs(args);
        return a.Count == 1 && a[0] is BsonString s && s.Value.Length > 0 ? s.Value : throw new ApiException($"{method}() takes a name.");
    }

    static int MatchParen(string text, List<Tok> toks, int open)
    {
        var depth = 0;
        for (var k = open; k < toks.Count; k++)
        {
            var c = text[toks[k].Start];
            if (toks[k].Type != T.Punct) continue;
            if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}' && --depth == 0)
            {
                if (c != ')') break;
                return k;
            }
        }
        throw new ApiException("Unbalanced parentheses.");
    }

    static string Unquote(string s) =>
        s.Length >= 2 && (s[0] is '"' or '\'') && s[^1] == s[0] ? s[1..^1] : s;

    // ---------------------------------------------------------------- formatting for the log

    static readonly MongoDB.Bson.IO.JsonWriterSettings ShellJson = new() { OutputMode = MongoDB.Bson.IO.JsonOutputMode.Shell, Indent = false };

    /// <summary>A value in shell syntax, for the log: <c>{ "a" : 1 }</c> → <c>{ a: 1 }</c>, long values shortened.</summary>
    public static string Show(BsonValue v, int max = 2000)
    {
        var s = v.ToJson(ShellJson);
        s = System.Text.RegularExpressions.Regex.Replace(s, "\"([A-Za-z_$][\\w$]*)\" : ", "$1: ");
        s = s.Replace(" : ", ": ");
        return s.Length > max ? s[..max] + " …" : s;
    }

    /// <summary>A collection reference in mongosh syntax: <c>db.getSiblingDB("x").users</c>.</summary>
    public static string Ref(string db, string? coll)
    {
        var d = $"db.getSiblingDB({Quote(db)})";
        if (coll == null) return d;
        return IsIdent(coll) ? $"{d}.{coll}" : $"{d}.getCollection({Quote(coll)})";
    }

    public static string Quote(string s) => System.Text.Json.JsonSerializer.Serialize(s);

    static bool IsIdent(string s) =>
        s.Length > 0 && (char.IsLetter(s[0]) || s[0] is '_' or '$') && s.All(c => char.IsLetterOrDigit(c) || c is '_' or '$')
        && !DbMethods.Contains(s) && s is not ("getCollection" or "getSiblingDB" or "getDB" or "getMongo");
}
