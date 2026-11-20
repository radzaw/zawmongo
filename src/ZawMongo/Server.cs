using MongoDB.Bson;
using MongoDB.Driver;

namespace ZawMongo;

public sealed record KillOpRequest(BsonJson Op);
public sealed record CreateUserRequest(string Db, string User, string? Password, List<RoleRef> Roles, string? Mechanism = null);
public sealed record RoleRef(string Role, string Db);
public sealed record UserRolesRequest(string Db, string User, List<RoleRef> Grant, List<RoleRef> Revoke);
public sealed record PasswordRequest(string Db, string User, string Password);
public sealed record DropUserRequest(string Db, string User);

/// <summary>The Host tab: server status, live monitor, running operations, users and the replica set.</summary>
public static class Server
{
    static BsonJson J(BsonValue v) => new(v);

    static Task<BsonDocument> Admin(DbSession s, BsonDocument cmd, CancellationToken ct) =>
        s.Db("admin").RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct);

    /// <summary>A whole server document: serverStatus, buildInfo, hostInfo, getCmdLineOpts or all parameters.</summary>
    public static async Task<BsonJson> DocumentAsync(DbSession s, string kind, OpLog log, CancellationToken ct)
    {
        var cmd = kind switch
        {
            "status" => new BsonDocument("serverStatus", 1),
            "build" => new BsonDocument("buildInfo", 1),
            "host" => new BsonDocument("hostInfo", 1),
            "cmdline" => new BsonDocument("getCmdLineOpts", 1),
            "parameters" => new BsonDocument("getParameter", "*"),
            _ => throw new ApiException($"Unknown server information: {kind}"),
        };
        var r = await log.Timed($"db.adminCommand({Shell.Show(cmd)})", () => Admin(s, cmd, ct));
        r.Remove("$clusterTime");
        r.Remove("operationTime");
        return J(r);
    }

    static BsonValue At(BsonDocument d, string path)
    {
        BsonValue cur = d;
        foreach (var p in path.Split('.'))
        {
            if (cur is not BsonDocument doc || !doc.TryGetValue(p, out cur)) return BsonNull.Value;
        }
        return cur;
    }

    static double? Num(BsonDocument d, string path) => At(d, path) is { IsNumeric: true } v ? v.ToDouble() : null;

    /// <summary>One sample of the live monitor: counters (the page turns them into rates) and gauges. Not logged.</summary>
    public static async Task<object> SampleAsync(DbSession s, CancellationToken ct)
    {
        var st = await Admin(s, new BsonDocument { { "serverStatus", 1 }, { "repl", 0 }, { "metrics", 1 }, { "locks", 0 } }, ct);
        return new
        {
            time = At(st, "localTime") is BsonDateTime t ? t.MillisecondsSinceEpoch : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            uptime = Num(st, "uptime"),
            host = At(st, "host").IsString ? st["host"].AsString : null,
            version = At(st, "version").IsString ? st["version"].AsString : null,
            ops = new
            {
                insert = Num(st, "opcounters.insert"),
                query = Num(st, "opcounters.query"),
                update = Num(st, "opcounters.update"),
                delete = Num(st, "opcounters.delete"),
                getmore = Num(st, "opcounters.getmore"),
                command = Num(st, "opcounters.command"),
            },
            docs = new
            {
                returned = Num(st, "metrics.document.returned"),
                inserted = Num(st, "metrics.document.inserted"),
                updated = Num(st, "metrics.document.updated"),
                deleted = Num(st, "metrics.document.deleted"),
            },
            scanned = new
            {
                keys = Num(st, "metrics.queryExecutor.scanned"),
                objects = Num(st, "metrics.queryExecutor.scannedObjects"),
            },
            connections = new { current = Num(st, "connections.current"), available = Num(st, "connections.available"), active = Num(st, "connections.active") },
            network = new { bytesIn = Num(st, "network.bytesIn"), bytesOut = Num(st, "network.bytesOut"), requests = Num(st, "network.numRequests") },
            mem = new { resident = Num(st, "mem.resident"), @virtual = Num(st, "mem.virtual") },
            cache = new
            {
                used = Num(st, "wiredTiger.cache.bytes currently in the cache"),
                max = Num(st, "wiredTiger.cache.maximum bytes configured"),
                dirty = Num(st, "wiredTiger.cache.tracked dirty bytes in the cache"),
                readInto = Num(st, "wiredTiger.cache.bytes read into cache"),
                writtenFrom = Num(st, "wiredTiger.cache.bytes written from cache"),
            },
            queue = new { readers = Num(st, "globalLock.currentQueue.readers"), writers = Num(st, "globalLock.currentQueue.writers") },
            active = new { readers = Num(st, "globalLock.activeClients.readers"), writers = Num(st, "globalLock.activeClients.writers") },
            latency = new
            {
                reads = Num(st, "opLatencies.reads.latency"), readOps = Num(st, "opLatencies.reads.ops"),
                writes = Num(st, "opLatencies.writes.latency"), writeOps = Num(st, "opLatencies.writes.ops"),
                commands = Num(st, "opLatencies.commands.latency"), commandOps = Num(st, "opLatencies.commands.ops"),
            },
            asserts = new { regular = Num(st, "asserts.regular"), warning = Num(st, "asserts.warning"), user = Num(st, "asserts.user") },
        };
    }

    /// <summary>Running operations (currentOp). <paramref name="all"/>: idle connections and system operations too.</summary>
    public static async Task<object> OperationsAsync(DbSession s, bool all, CancellationToken ct)
    {
        var cmd = new BsonDocument("currentOp", 1);
        if (all) cmd["$all"] = true;
        var r = await Admin(s, cmd, ct);
        var ops = r.GetValue("inprog", new BsonArray()).AsBsonArray.OfType<BsonDocument>().Where(o => all || !IsBackground(o)).Select(o => new
        {
            opid = J(o.GetValue("opid", BsonNull.Value)),
            op = o.GetValue("op", "").ToString(),
            ns = o.GetValue("ns", "").ToString(),
            active = o.GetValue("active", false).ToBoolean(),
            secs = o.GetValue("secs_running", BsonNull.Value) is { IsNumeric: true } sr ? sr.ToInt64() : (long?)null,
            micros = o.GetValue("microsecs_running", BsonNull.Value) is { IsNumeric: true } mr ? mr.ToInt64() : (long?)null,
            client = o.GetValue("client", o.GetValue("client_s", "")).ToString(),
            app = o.GetValue("appName", "").ToString(),
            user = o.GetValue("effectiveUsers", BsonNull.Value) is BsonArray eu && eu.Count > 0 ? eu[0].AsBsonDocument.GetValue("user", "").ToString() : null,
            desc = o.GetValue("desc", "").ToString(),
            waitingForLock = o.GetValue("waitingForLock", false).ToBoolean(),
            planSummary = o.GetValue("planSummary", "").ToString(),
            command = o.TryGetValue("command", out var c) ? J(c) : null,
            msg = o.GetValue("msg", "").ToString(),
            raw = J(o),
        }).OrderByDescending(o => o.micros ?? -1).ToList();
        return ops;
    }

    /// <summary>
    /// Server threads (checkpointer, oplog applier …) and drivers' monitoring connections waiting in an awaitable
    /// hello: currentOp lists them as active, but they are not anybody's work. Shown with "All".
    /// </summary>
    public static bool IsBackground(BsonDocument o)
    {
        if (o.GetValue("isFromUserConnection", true) is BsonBoolean { Value: false }) return true;
        return o.GetValue("command", BsonNull.Value) is BsonDocument c && c.ElementCount > 0
            && c.GetElement(0).Name is "hello" or "isMaster" or "ismaster" && c.Contains("maxAwaitTimeMS");
    }

    public static async Task KillAsync(DbSession s, BsonValue op, OpLog log, CancellationToken ct)
    {
        var cmd = new BsonDocument { { "killOp", 1 }, { "op", op } };
        await log.Timed($"db.adminCommand({Shell.Show(cmd)})", () => Admin(s, cmd, ct));
    }

    // ---------------------------------------------------------------- users

    /// <summary>Users of one database, or of every database (db null; needs privileges on admin).</summary>
    public static async Task<object> UsersAsync(DbSession s, string? db, OpLog log, CancellationToken ct)
    {
        var cmd = db == null ? new BsonDocument("usersInfo", new BsonDocument("forAllDBs", true)) : new BsonDocument("usersInfo", 1);
        var r = await log.Timed($"{Shell.Ref(db ?? "admin", null)}.runCommand({Shell.Show(cmd)})", () => s.Db(db ?? "admin").RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
        return r["users"].AsBsonArray.OfType<BsonDocument>().Select(u => new
        {
            user = u.GetValue("user", "").ToString(),
            db = u.GetValue("db", "").ToString(),
            roles = u.GetValue("roles", new BsonArray()).AsBsonArray.OfType<BsonDocument>().Select(x => new { role = x["role"].ToString(), db = x["db"].ToString() }).ToList(),
            mechanisms = u.GetValue("mechanisms", new BsonArray()).AsBsonArray.Select(m => m.ToString()).ToList(),
        }).OrderBy(u => u.db, StringComparer.Ordinal).ThenBy(u => u.user, StringComparer.Ordinal).ToList();
    }

    /// <summary>Roles that can be granted in a database: built-in and user-defined.</summary>
    public static async Task<object> RolesAsync(DbSession s, string db, CancellationToken ct)
    {
        var r = await s.Db(db).RunCommandAsync<BsonDocument>(new BsonDocument { { "rolesInfo", 1 }, { "showBuiltinRoles", true } }, cancellationToken: ct);
        return r["roles"].AsBsonArray.OfType<BsonDocument>().Select(x => new
        {
            role = x["role"].ToString(),
            db = x["db"].ToString(),
            builtin = x.GetValue("isBuiltin", false).ToBoolean(),
        }).OrderBy(x => !x.builtin).ThenBy(x => x.role, StringComparer.Ordinal).ToList();
    }

    static BsonArray Roles(IEnumerable<RoleRef> roles) => new(roles.Select(r => new BsonDocument { { "role", r.Role }, { "db", r.Db } }));

    /// <summary>The log line for a user command: the password is never written.</summary>
    static string Masked(string db, BsonDocument cmd)
    {
        var shown = cmd.DeepClone().AsBsonDocument;
        if (shown.Contains("pwd")) shown["pwd"] = "********";
        return $"{Shell.Ref(db, null)}.runCommand({Shell.Show(shown)})";
    }

    public static async Task CreateUserAsync(DbSession s, CreateUserRequest r, OpLog log, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(r.User)) throw new ApiException("Enter a user name.");
        var cmd = new BsonDocument { { "createUser", r.User.Trim() } };
        if (r.Db != "$external")
        {
            if (string.IsNullOrEmpty(r.Password)) throw new ApiException("Enter a password.");
            cmd["pwd"] = r.Password;
        }
        cmd["roles"] = Roles(r.Roles);
        if (!string.IsNullOrEmpty(r.Mechanism)) cmd["mechanisms"] = new BsonArray { r.Mechanism };
        await log.Timed(Masked(r.Db, cmd), () => s.Db(r.Db).RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
    }

    public static async Task SetPasswordAsync(DbSession s, PasswordRequest r, OpLog log, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(r.Password)) throw new ApiException("Enter a password.");
        var cmd = new BsonDocument { { "updateUser", r.User }, { "pwd", r.Password } };
        await log.Timed(Masked(r.Db, cmd), () => s.Db(r.Db).RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
    }

    public static async Task SetRolesAsync(DbSession s, UserRolesRequest r, OpLog log, CancellationToken ct)
    {
        var db = s.Db(r.Db);
        if (r.Grant.Count > 0)
        {
            var cmd = new BsonDocument { { "grantRolesToUser", r.User }, { "roles", Roles(r.Grant) } };
            await log.Timed(Masked(r.Db, cmd), () => db.RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
        }
        if (r.Revoke.Count > 0)
        {
            var cmd = new BsonDocument { { "revokeRolesFromUser", r.User }, { "roles", Roles(r.Revoke) } };
            await log.Timed(Masked(r.Db, cmd), () => db.RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
        }
    }

    public static async Task DropUserAsync(DbSession s, DropUserRequest r, OpLog log, CancellationToken ct)
    {
        var cmd = new BsonDocument("dropUser", r.User);
        await log.Timed(Masked(r.Db, cmd), () => s.Db(r.Db).RunCommandAsync<BsonDocument>(cmd, cancellationToken: ct));
    }

    // ---------------------------------------------------------------- replica set

    /// <summary>The replica set's members with their state, health and lag behind the primary. Not logged (polled).</summary>
    public static async Task<object> ReplicationAsync(DbSession s, CancellationToken ct)
    {
        BsonDocument status;
        try
        {
            status = await Admin(s, new BsonDocument("replSetGetStatus", 1), ct);
        }
        catch (MongoCommandException ex) when (ex.Code is 76 or 13 or 59)
        {
            var hello = await Admin(s, new BsonDocument("hello", 1), ct);
            var sharded = hello.GetValue("msg", "").ToString() == "isdbgrid";
            return new
            {
                replicaSet = false,
                message = ex.Code == 13 ? "Not authorized to read the replica set status (replSetGetStatus needs the clusterMonitor role)."
                    : sharded ? "This is a mongos router of a sharded cluster; connect to a shard's replica set to see its members."
                    : "This server is not part of a replica set (it runs standalone).",
            };
        }
        BsonDocument? config = null;
        try { config = (await Admin(s, new BsonDocument("replSetGetConfig", 1), ct)).GetValue("config", BsonNull.Value) as BsonDocument; }
        catch (MongoCommandException) { /* no privilege */ }
        var members = status.GetValue("members", new BsonArray()).AsBsonArray.OfType<BsonDocument>().ToList();
        var primary = members.FirstOrDefault(m => m.GetValue("stateStr", "").ToString() == "PRIMARY");
        DateTime? Optime(BsonDocument m) => m.GetValue("optimeDate", BsonNull.Value) is BsonDateTime d ? d.ToUniversalTime() : null;
        var primaryOptime = primary == null ? null : Optime(primary);
        var cfgMembers = config?.GetValue("members", new BsonArray()).AsBsonArray.OfType<BsonDocument>().ToDictionary(m => m["_id"].ToInt32()) ?? [];
        return new
        {
            replicaSet = true,
            set = status.GetValue("set", "").ToString(),
            date = status.GetValue("date", BsonNull.Value) is BsonDateTime dt ? dt.ToUniversalTime() : (DateTime?)null,
            heartbeatMs = status.GetValue("heartbeatIntervalMillis", BsonNull.Value) is { IsNumeric: true } hb ? hb.ToInt64() : (long?)null,
            term = status.GetValue("term", BsonNull.Value) is { IsNumeric: true } tm ? tm.ToInt64() : (long?)null,
            members = members.Select(m =>
            {
                var id = m.GetValue("_id", 0).ToInt32();
                cfgMembers.TryGetValue(id, out var cfg);
                var optime = Optime(m);
                return new
                {
                    id,
                    name = m.GetValue("name", "").ToString(),
                    state = m.GetValue("stateStr", "").ToString(),
                    health = m.GetValue("health", 0).ToDouble(),
                    self = m.GetValue("self", false).ToBoolean(),
                    uptime = m.GetValue("uptime", BsonNull.Value) is { IsNumeric: true } u ? u.ToInt64() : (long?)null,
                    optime,
                    lagSeconds = optime != null && primaryOptime != null ? Math.Max(0, (primaryOptime.Value - optime.Value).TotalSeconds) : (double?)null,
                    pingMs = m.GetValue("pingMs", BsonNull.Value) is { IsNumeric: true } p ? p.ToInt64() : (long?)null,
                    syncSource = m.GetValue("syncSourceHost", "").ToString(),
                    lastHeartbeat = m.GetValue("lastHeartbeatRecv", BsonNull.Value) is BsonDateTime lh ? lh.ToUniversalTime() : (DateTime?)null,
                    message = m.GetValue("lastHeartbeatMessage", m.GetValue("infoMessage", "")).ToString(),
                    priority = cfg?.GetValue("priority", BsonNull.Value) is { IsNumeric: true } pr ? pr.ToDouble() : (double?)null,
                    votes = cfg?.GetValue("votes", BsonNull.Value) is { IsNumeric: true } v ? v.ToInt32() : (int?)null,
                    hidden = cfg?.GetValue("hidden", false).ToBoolean() ?? false,
                    arbiterOnly = cfg?.GetValue("arbiterOnly", false).ToBoolean() ?? false,
                    delaySecs = cfg?.GetValue("secondaryDelaySecs", cfg.GetValue("slaveDelay", BsonNull.Value)) is { IsNumeric: true } ds ? ds.ToInt64() : (long?)null,
                };
            }).ToList(),
            config = config == null ? null : J(config),
        };
    }
}
