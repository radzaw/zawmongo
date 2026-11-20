using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;

namespace ZawMongo;

public sealed record ConnectRequest(string? SessionId, SessionProfile? Profile, string? Password, string? SshSecret = null);
public sealed record HostKeyRequest(string? Fingerprint);
/// <summary>Tab: the query tab, so Stop can cancel its run. Database: what "db" stands for at the start.</summary>
public sealed record ExecRequest(string Script, string? Database, int MaxDocs = 1000, bool StopOnError = true, string? Tab = null);
public sealed record DocGetRequest(string Db, string Coll, BsonJson Id);
public sealed record CreateCollectionRequest(string Db, string Name, string? Options);
public sealed record CollectionRequest(string Db, string Coll);
public sealed record RenameRequest(string Db, string Coll, string To, bool DropTarget = false);
public sealed record DropDatabaseRequest(string Db);
public sealed record CreateIndexRequest(string Db, string Coll, string Keys, string? Options);
public sealed record DropIndexRequest(string Db, string Coll, string Name);
public sealed record ValidationRequest(string Db, string Coll, string? Validator, string? Level, string? Action);
public sealed record SampleRequest(string Db, string Coll, int Size = 1000, string? Filter = null);

public static class Api
{
    /// <summary>Error code for an SSH host key the user hasn't trusted yet; data carries the fingerprint.</summary>
    public const int SshHostKeyUnknown = 9001;
    public const int LibraryConflict = 9002;

    const string ReadOnlyMessage = "This session is in read-only mode; changes are not allowed.";

    /// <summary>LogTimes: when each Log line was logged (Unix ms). LogMs: how long each command took (ms), null for comments.</summary>
    sealed record Response(bool Ok, object? Data, string? Error, int? Code, List<string> Log, List<long>? LogTimes = null, List<double?>? LogMs = null);

    static async Task<IResult> Run(Func<OpLog, Task<object?>> body)
    {
        var log = new OpLog();
        try
        {
            return Results.Json(new Response(true, await body(log), null, null, log.Items, log.Times, log.Ms));
        }
        catch (MongoCommandException ex)
        {
            log.Note($"Error ({ex.Code} {ex.CodeName}): {ex.ErrorMessage}");
            return Results.Json(new Response(false, null, $"{ex.ErrorMessage} ({ex.CodeName})", ex.Code, log.Items, log.Times, log.Ms));
        }
        catch (MongoWriteException ex)
        {
            log.Note($"Write error ({ex.WriteError?.Code}): {ex.WriteError?.Message}");
            return Results.Json(new Response(false, null, ex.WriteError?.Message ?? ex.Message, ex.WriteError?.Code, log.Items, log.Times, log.Ms));
        }
        catch (MongoBulkWriteException ex)
        {
            var first = ex.WriteErrors.FirstOrDefault();
            log.Note($"Write error: {first?.Message ?? ex.Message}");
            return Results.Json(new Response(false, null, first != null ? $"{first.Message}{(ex.WriteErrors.Count > 1 ? $" (and {ex.WriteErrors.Count - 1} more errors)" : "")}" : ex.Message, first?.Code, log.Items, log.Times, log.Ms));
        }
        catch (TimeoutException ex)
        {
            var msg = ServerSelectionMessage(ex.Message);
            log.Note(msg);
            return Results.Json(new Response(false, null, msg, null, log.Items, log.Times, log.Ms));
        }
        catch (MongoAuthenticationException ex)
        {
            log.Note($"Authentication failed: {ex.Message}");
            return Results.Json(new Response(false, null, $"Authentication failed: {(ex.InnerException ?? ex).Message}", 18, log.Items, log.Times, log.Ms));
        }
        catch (SshHostKeyUnknownException ex)
        {
            log.Note($"{ex.Message} Fingerprint: {ex.Fingerprint}");
            return Results.Json(new Response(false, new { host = ex.Host, port = ex.Port, fingerprint = ex.Fingerprint }, ex.Message, SshHostKeyUnknown, log.Items, log.Times, log.Ms));
        }
        catch (LibraryConflictException ex)
        {
            return Results.Json(new Response(false, null, ex.Message, LibraryConflict, log.Items, log.Times, log.Ms));
        }
        catch (OperationCanceledException)
        {
            return Results.Json(new Response(false, null, "The operation was cancelled.", null, log.Items, log.Times, log.Ms));
        }
        catch (Exception ex)
        {
            return Results.Json(new Response(false, null, ex.Message, null, log.Items, log.Times, log.Ms));
        }
    }

    /// <summary>The driver's server selection timeout lists the whole cluster description; the reason is what matters.</summary>
    public static string ServerSelectionMessage(string message)
    {
        var m = Regex.Match(message, @"""(?:HeartbeatException|AuthenticationException)""[^}]*?:\s*""([^""]+)""");
        var reason = Regex.Match(message, @"Exception: ([^""\]\r\n]+?)(?:\s*--->|""|\r|\n|$)");
        var detail = m.Success ? m.Groups[1].Value : reason.Success ? reason.Groups[1].Value.Trim() : null;
        return "The server didn't answer in time" + (detail != null ? $": {detail}" : ".") + " Check the host, port, TLS setting and that the server is running.";
    }

    static Task<IResult> RunSync(Func<object?> body) => Run(_ => Task.FromResult(body()));

    /// <summary>Runs a request on a connected session; <paramref name="write"/> refuses read-only sessions.</summary>
    static Task<IResult> On(ConnectionManager cm, string sid, Func<DbSession, OpLog, Task<object?>> body, bool write = false) =>
        Run(async log =>
        {
            var s = cm.Get(sid);
            if (write && s.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            return await body(s, log);
        });

    static (SessionProfile, string?, string?) ResolveProfile(ConnectRequest r, SessionStore st)
    {
        var p = r.Profile ?? (r.SessionId != null ? st.Get(r.SessionId) : null) ?? throw new ApiException("Session not found.");
        if (p.Mode == "uri" && p.Uri != null)
        {
            // A password typed into the connection string counts as the session's password.
            var (uri, inUri) = ConnectionManager.SplitPassword(p.Uri);
            p.Uri = uri;
            if (inUri != null && string.IsNullOrEmpty(p.Password)) p.Password = inUri;
        }
        var pwd = r.Password ?? (string.IsNullOrEmpty(p.Password) ? null : p.Password) ?? (p.Id != null ? st.GetPassword(p.Id) : null);
        var sshSecret = r.SshSecret ?? (string.IsNullOrEmpty(p.SshSecret) ? null : p.SshSecret) ?? (p.Id != null ? st.GetSshSecret(p.Id) : null);
        // An unsaved profile (connection test) may not carry the host key the user trusted earlier.
        if (p.SshHostKey == null && p.Id != null) p.SshHostKey = st.Get(p.Id)?.SshHostKey;
        return (p, pwd, sshSecret);
    }

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api");

        // ---- application ----
        api.MapPost("/ping", (string? page, Heartbeat hb) => { hb.Ping(page); return Results.Ok(); });
        api.MapPost("/bye", (string? page, Heartbeat hb) => { hb.Bye(page); return Results.Ok(); });
        api.MapPost("/exit", (IHostApplicationLifetime life) =>
        {
            _ = Task.Delay(300).ContinueWith(_ => life.StopApplication());
            return RunSync(() => null);
        });
        api.MapGet("/state", (SessionStore st) => RunSync(() => st.LoadState()));
        api.MapPut("/state", async (HttpRequest req, SessionStore st) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            st.SaveState(doc.RootElement.GetRawText());
            return Results.Json(new Response(true, null, null, null, []));
        });
        api.MapGet("/library", (SessionStore st) => RunSync(() => st.LoadLibrary()));
        api.MapPut("/library", async (HttpRequest req, SessionStore st) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            return await RunSync(() => new { revision = st.SaveLibrary(doc.RootElement) });
        });

        // ---- the native window's file dialogs (macOS and Linux web views have none for the page) ----
        api.MapPost("/native/open", (NativeOpenRequest req, AppWindow win) => Run(async _ => await win.OpenDialogAsync(req.Accept, req.Multiple)));
        api.MapGet("/native/file/{id}", (string id, AppWindow win) =>
            win.TakePicked(id) is { } path ? Results.File(path, "application/octet-stream") : Results.NotFound());
        api.MapPost("/native/save", (NativeSaveRequest req, AppWindow win) => Run(async _ =>
        {
            var path = await win.SaveDialogAsync(req.Description ?? "Files", req.Ext ?? "");
            if (path == null) return null;
            await File.WriteAllTextAsync(path, req.Text ?? "", new UTF8Encoding(false));
            return new { name = Path.GetFileName(path) };
        }));

        // ---- self-update ----
        api.MapGet("/version", (Updater u) => RunSync(() => u.Version()));
        api.MapPost("/update/check", (Updater u, CancellationToken ct) => Run(async _ => await u.CheckAsync(ct)));
        api.MapGet("/update/notes", (string? since, Updater u, CancellationToken ct) => Run(async _ => await u.NotesAsync(since, ct)));
        api.MapPost("/update/download", (Updater u) => RunSync(() => u.StartDownload()));
        api.MapGet("/update/status", (Updater u) => RunSync(() => u.Status()));
        api.MapPost("/update/install", (Updater u, IHostApplicationLifetime life, HttpContext ctx) => RunSync(() =>
            new { version = u.InstallAndRestart(life, ctx.Connection.LocalPort), restarting = true }));

        // ---- import files (not tied to a session) ----
        api.MapPost("/import/upload", async (HttpContext ctx, string name, ImportStore store, CancellationToken ct) =>
        {
            if (ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
                limit.MaxRequestBodySize = 8L * 1024 * 1024 * 1024;
            return await Run(async _ =>
            {
                var f = await store.SaveAsync(ctx.Request.Body, name, ct);
                return new { id = f.Id, name = f.Name, size = f.Size, format = Transfer.Detect(f.Name, f.Path) };
            });
        });
        api.MapPost("/import/preview", (ImportPreviewRequest r, ImportStore store) => RunSync(() => Transfer.Preview(store, r)));
        api.MapDelete("/import/{id}", (string id, ImportStore store) => RunSync(() => { store.Delete(id); return null; }));

        // ---- saved sessions ----
        api.MapGet("/sessions", (SessionStore st) => RunSync(() => st.List()));
        api.MapPost("/sessions", (SessionProfile p, SessionStore st) => RunSync(() =>
        {
            // A password in the connection string is stored encrypted like any other, not in the string.
            if (p.Mode == "uri" && p.Uri != null)
            {
                var (uri, pwd) = ConnectionManager.SplitPassword(p.Uri);
                p.Uri = uri;
                if (pwd != null) p.Password = pwd;
            }
            return st.Save(p);
        }));
        api.MapPost("/sessions/{id}/hostkey", (string id, HostKeyRequest r, SessionStore st) => RunSync(() =>
        {
            if (r.Fingerprint != null && !r.Fingerprint.StartsWith("SHA256:", StringComparison.Ordinal)) throw new ApiException("Invalid host key fingerprint.");
            st.SetSshHostKey(id, r.Fingerprint);
            return null;
        }));
        api.MapDelete("/sessions/{id}", (string id, SessionStore st) => RunSync(() => { st.Delete(id); return null; }));

        api.MapPost("/connect", (ConnectRequest r, SessionStore st, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var (p, pwd, sshSecret) = ResolveProfile(r, st);
            var s = await cm.ConnectAsync(p, pwd, sshSecret, log, ct);
            try { return await cm.InfoAsync(s, log, ct); }
            catch
            {
                await cm.DisconnectAsync(s.Id);
                throw;
            }
        }));
        api.MapPost("/test", (ConnectRequest r, SessionStore st, CancellationToken ct) => Run(async log =>
        {
            var (p, pwd, sshSecret) = ResolveProfile(r, st);
            return await ConnectionManager.TestAsync(p, pwd, sshSecret, log, ct);
        }));

        // ---- per connected session ----
        var s = api.MapGroup("/s/{sid}");

        s.MapPost("/disconnect", (string sid, ConnectionManager cm) => Run(async _ => { await cm.DisconnectAsync(sid); return null; }));
        s.MapGet("/info", (string sid, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await cm.InfoAsync(ses, log, ct)));

        // ---- tree, Database and Collection tabs ----
        s.MapGet("/databases", (string sid, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.DatabasesAsync(ses, log, ct)));
        s.MapGet("/collections", (string sid, string db, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.CollectionsAsync(ses, db, log, ct)));
        s.MapGet("/collection", (string sid, string db, string coll, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.CollectionAsync(ses, db, coll, log, ct)));
        s.MapGet("/dbstats", (string sid, string db, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            var r = await log.Timed($"{Shell.Ref(db, null)}.stats()", () => ses.Db(db).RunCommandAsync<BsonDocument>(new BsonDocument("dbStats", 1), cancellationToken: ct));
            r.Remove("$clusterTime");
            r.Remove("operationTime");
            return new BsonJson(r);
        }));
        s.MapPost("/schema", (string sid, SampleRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
            await Schema.SampleAsync(ses, r.Db, r.Coll, r.Size, r.Filter, log, ct)));

        s.MapPost("/collections/create", (string sid, CreateCollectionRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            if (string.IsNullOrWhiteSpace(r.Name)) throw new ApiException("Enter a collection name.");
            var cmd = new BsonDocument("create", r.Name.Trim());
            cmd.AddRange(Shell.ParseDocument(r.Options, "options"));
            await log.Timed($"{Shell.Ref(r.Db, null)}.runCommand({Shell.Show(cmd)})", () => ses.Db(r.Db).RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
            return null;
        }, write: true));
        s.MapPost("/collections/drop", (string sid, CollectionRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.drop()", async () => { await ses.Db(r.Db).DropCollectionAsync(r.Coll, ct); return 0; });
            return null;
        }, write: true));
        s.MapPost("/collections/rename", (string sid, RenameRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            if (string.IsNullOrWhiteSpace(r.To)) throw new ApiException("Enter the new name.");
            await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.renameCollection({Shell.Quote(r.To.Trim())}{(r.DropTarget ? ", true" : "")})", async () =>
            {
                await ses.Db(r.Db).RenameCollectionAsync(r.Coll, r.To.Trim(), new RenameCollectionOptions { DropTarget = r.DropTarget }, ct);
                return 0;
            });
            return null;
        }, write: true));
        s.MapPost("/databases/drop", (string sid, DropDatabaseRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            await log.Timed($"{Shell.Ref(r.Db, null)}.dropDatabase()", async () => { await ses.Client.DropDatabaseAsync(r.Db, ct); return 0; });
            return null;
        }, write: true));
        s.MapPost("/indexes/create", (string sid, CreateIndexRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            var keys = Shell.ParseDocument(r.Keys, "index keys");
            if (keys.ElementCount == 0) throw new ApiException("An index needs at least one field.");
            var spec = new BsonDocument { { "key", keys } };
            var opts = Shell.ParseDocument(r.Options, "options");
            spec["name"] = opts.GetValue("name", ShellRunner.IndexName(keys));
            foreach (var e in opts.Elements.Where(e => e.Name != "name")) spec[e.Name] = e.Value;
            var cmd = new BsonDocument { { "createIndexes", r.Coll }, { "indexes", new BsonArray { spec } } };
            opts.Remove("name");
            await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.createIndex({Shell.Show(keys)}, {Shell.Show(new BsonDocument("name", spec["name"]).AddRange(opts))})", () =>
                ses.Db(r.Db).RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
            return new { name = spec["name"].AsString };
        }, write: true));
        s.MapPost("/indexes/drop", (string sid, DropIndexRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            if (r.Name == "_id_") throw new ApiException("The _id index can't be dropped.");
            await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.dropIndex({Shell.Quote(r.Name)})", async () => { await ses.Coll(r.Db, r.Coll).Indexes.DropOneAsync(r.Name, ct); return 0; });
            return null;
        }, write: true));
        s.MapPost("/validation", (string sid, ValidationRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            var cmd = new BsonDocument { { "collMod", r.Coll }, { "validator", Shell.ParseDocument(r.Validator, "validator") } };
            if (r.Level is "off" or "strict" or "moderate") cmd["validationLevel"] = r.Level;
            if (r.Action is "error" or "warn" or "errorAndLog") cmd["validationAction"] = r.Action;
            await log.Timed($"{Shell.Ref(r.Db, null)}.runCommand({Shell.Show(cmd)})", () => ses.Db(r.Db).RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
            return null;
        }, write: true));

        // ---- Documents tab ----
        s.MapPost("/find", (string sid, FindRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.FindAsync(ses, r, log, ct)));
        s.MapPost("/doc", (string sid, DocGetRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            var filter = new BsonDocument("_id", r.Id.Value);
            var d = await log.Timed($"{Shell.Ref(r.Db, r.Coll)}.findOne({Shell.Show(filter)})", () => ses.Coll(r.Db, r.Coll).Find(filter).FirstOrDefaultAsync(ct));
            return d == null ? throw new ApiException("The document no longer exists.") : new BsonJson(d);
        }));
        s.MapPost("/docs/insert", (string sid, DocInsertRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.InsertAsync(ses, r, log, ct), write: true));
        s.MapPost("/docs/replace", (string sid, DocReplaceRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.ReplaceAsync(ses, r, log, ct), write: true));
        s.MapPost("/docs/field", (string sid, DocFieldRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.SetFieldAsync(ses, r, log, ct), write: true));
        s.MapPost("/docs/delete", (string sid, DocDeleteRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.DeleteAsync(ses, r, log, ct), write: true));
        s.MapPost("/docs/bulk", (string sid, DocBulkRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Browse.BulkAsync(ses, r, log, ct), write: true));

        // ---- query tabs: shell statements ----
        s.MapPost("/exec", (string sid, ExecRequest req, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var key = req.Tab ?? Guid.NewGuid().ToString("n");
            ses.Running[key] = cts;
            try
            {
                var runner = new ShellRunner(ses, log, Math.Clamp(req.MaxDocs, 1, 100_000), cts.Token)
                {
                    Database = string.IsNullOrWhiteSpace(req.Database) ? "test" : req.Database,
                };
                var statements = Shell.Split(req.Script);
                var results = new List<ShellResult>();
                var errors = new List<object>();
                var executed = 0;
                for (var i = 0; i < statements.Count; i++)
                {
                    try
                    {
                        var r = await runner.RunAsync(Shell.Parse(statements[i].Text));
                        r.Statement = i;
                        results.Add(r);
                        executed++;
                    }
                    catch (Exception ex) when (ex is ApiException or MongoException or FormatException or TimeoutException && !cts.IsCancellationRequested)
                    {
                        var msg = ex is MongoCommandException mc ? $"{mc.ErrorMessage} ({mc.CodeName})"
                            : ex is MongoWriteException mw ? mw.WriteError?.Message ?? mw.Message
                            : ex is TimeoutException ? ServerSelectionMessage(ex.Message) : ex.Message;
                        log.Note($"Error: {msg}");
                        errors.Add(new { statement = i, message = msg, start = statements[i].Start, end = statements[i].End });
                        if (req.StopOnError) break;
                    }
                }
                return new { results, errors, statements = statements.Count, executed, database = runner.Database };
            }
            finally { ses.Running.TryRemove(key, out _); }
        }));
        s.MapPost("/cancel", (string sid, string? tab, ConnectionManager cm) => RunSync(() =>
        {
            var ses = cm.Get(sid);
            foreach (var (k, cts) in ses.Running)
                if (tab == null || k == tab) { try { cts.Cancel(); } catch (ObjectDisposedException) { } }
            return null;
        }));

        // ---- Host tab ----
        s.MapGet("/server", (string sid, string kind, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Server.DocumentAsync(ses, kind, log, ct)));
        s.MapGet("/monitor", (string sid, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, _) => await Server.SampleAsync(ses, ct)));
        s.MapGet("/ops", (string sid, bool? all, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, _) => await Server.OperationsAsync(ses, all ?? false, ct)));
        s.MapPost("/killop", (string sid, KillOpRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
        {
            await Server.KillAsync(ses, r.Op.Value, log, ct);
            return null;
        }, write: true));
        s.MapGet("/replication", (string sid, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, _) => await Server.ReplicationAsync(ses, ct)));
        s.MapGet("/users", (string sid, string? db, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => await Server.UsersAsync(ses, string.IsNullOrEmpty(db) ? null : db, log, ct)));
        s.MapGet("/roles", (string sid, string db, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, _) => await Server.RolesAsync(ses, db, ct)));
        s.MapPost("/users/create", (string sid, CreateUserRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => { await Server.CreateUserAsync(ses, r, log, ct); return null; }, write: true));
        s.MapPost("/users/password", (string sid, PasswordRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => { await Server.SetPasswordAsync(ses, r, log, ct); return null; }, write: true));
        s.MapPost("/users/roles", (string sid, UserRolesRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => { await Server.SetRolesAsync(ses, r, log, ct); return null; }, write: true));
        s.MapPost("/users/drop", (string sid, DropUserRequest r, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) => { await Server.DropUserAsync(ses, r, log, ct); return null; }, write: true));

        // ---- import / export ----
        s.MapPost("/import/run", (string sid, ImportRunRequest r, ImportStore store, ConnectionManager cm, CancellationToken ct) => On(cm, sid, async (ses, log) =>
            await Transfer.ImportAsync(ses, store, r, log, ct), write: true));

        // toFile: the native window (macOS, Linux) asks where to save and the file is written there, not downloaded.
        s.MapGet("/export", async (HttpContext ctx, string sid, string db, string coll, string? filter, string? sort, string? projection, int? limit,
            string? format, bool? canonical, string? fields, bool? toFile, ConnectionManager cm, AppWindow win) =>
        {
            var ct = ctx.RequestAborted;
            var ses = cm.Get(sid);
            var fmt = format is "csv" or "ndjson" ? format : "json";
            List<string>? cols = string.IsNullOrWhiteSpace(fields) ? null : fields.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
            async Task<IAsyncCursor<BsonDocument>> Open()
            {
                var f = ses.Coll(db, coll).Find(Shell.ParseDocument(filter, "filter"));
                var srt = Shell.ParseDocument(sort, "sort");
                if (srt.ElementCount > 0) f = f.Sort(srt);
                if (limit is > 0) f = f.Limit(limit);
                return await f.Project<BsonDocument>(Shell.ParseDocument(projection, "projection")).ToCursorAsync(ct);
            }
            var ext = fmt == "csv" ? ".csv" : fmt == "ndjson" ? ".ndjson" : ".json";
            if (toFile == true)
            {
                return await Run(async log =>
                {
                    var path = await win.SaveDialogAsync(fmt == "csv" ? "CSV files" : "JSON files", ext);
                    if (path == null) return null;
                    log.Note($"Exporting {db}.{coll} to {Path.GetFileName(path)}");
                    var cursor = await Open();
                    await using (var w = new StreamWriter(path, false, new UTF8Encoding(false), 1 << 16)) await Transfer.WriteAsync(cursor, w, fmt, canonical == true, cols, ct);
                    return new { name = Path.GetFileName(path) };
                });
            }
            var name = Regex.Replace($"{db}.{coll}", @"[^\w\-.]+", "_") + ext;
            IAsyncCursor<BsonDocument> cur;
            try { cur = await Open(); }
            catch (Exception ex) when (ex is ApiException or MongoException) { return Results.Text(ex.Message, statusCode: 400); }
            ctx.Response.ContentType = (fmt == "csv" ? "text/csv" : "application/json") + "; charset=utf-8";
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
            await using (var w = new StreamWriter(ctx.Response.Body, new UTF8Encoding(false), 1 << 16))
            {
                // The download has started: an error can only end the file early.
                try { await Transfer.WriteAsync(cur, w, fmt, canonical == true, cols, ct); }
                catch (Exception ex) when (ex is not OperationCanceledException) { }
            }
            return Results.Empty;
        });
    }
}
