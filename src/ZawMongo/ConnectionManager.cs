using System.Collections.Concurrent;
using MongoDB.Bson;
using MongoDB.Driver;

namespace ZawMongo;

/// <summary>One open server connection in the UI: a driver client (its own connection pool) and an SSH tunnel.</summary>
public sealed class DbSession
{
    public required string Id { get; init; }
    public required SessionProfile Profile { get; init; }
    public required MongoClient Client { get; init; }
    /// <summary>SSH tunnel all connections of this session go through, if enabled.</summary>
    public SshTunnel? Tunnel { get; init; }
    /// <summary>Running query tab requests by tab id, so Stop can cancel them.</summary>
    public ConcurrentDictionary<string, CancellationTokenSource> Running { get; } = new();

    public IMongoDatabase Db(string name)
    {
        Tunnel?.EnsureConnected(new OpLog());
        if (string.IsNullOrEmpty(name)) throw new ApiException("No database selected.");
        return Client.GetDatabase(name);
    }

    public IMongoCollection<BsonDocument> Coll(string db, string coll) => Db(db).GetCollection<BsonDocument>(coll);
}

public sealed class ConnectionManager : IAsyncDisposable
{
    readonly ConcurrentDictionary<string, DbSession> sessions = new();

    /// <summary>
    /// The password of a connection string, and the string without it: profiles keep the password encrypted apart
    /// from the rest. Returns the input and null when there is no password (or the text isn't a connection string).
    /// </summary>
    public static (string Uri, string? Password) SplitPassword(string uri)
    {
        try
        {
            var u = new MongoUrlBuilder(uri.Trim());
            if (u.Password == null) return (uri.Trim(), null);
            var pwd = u.Password;
            u.Password = null;
            return (u.ToString(), pwd);
        }
        catch (Exception ex) when (ex is MongoConfigurationException or ArgumentException or FormatException)
        {
            return (uri, null);
        }
    }

    /// <summary>Driver settings for a profile; with an SSH tunnel the server is the tunnel's local port.</summary>
    public static MongoClientSettings BuildSettings(SessionProfile p, string? password, uint? tunnelPort = null)
    {
        MongoUrlBuilder u;
        if (p.Mode == "uri")
        {
            if (string.IsNullOrWhiteSpace(p.Uri)) throw new ApiException("Enter a connection string (mongodb://… or mongodb+srv://…).");
            try { u = new MongoUrlBuilder(p.Uri.Trim()); }
            catch (Exception ex) when (ex is MongoConfigurationException or ArgumentException or FormatException)
            {
                throw new ApiException($"Invalid connection string: {ex.Message}");
            }
            if (!string.IsNullOrEmpty(password) && u.Username != null) u.Password = password;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(p.Host)) throw new ApiException("Enter the server's host name.");
            u = new MongoUrlBuilder
            {
                Scheme = p.Srv ? MongoDB.Driver.Core.Configuration.ConnectionStringScheme.MongoDBPlusSrv : MongoDB.Driver.Core.Configuration.ConnectionStringScheme.MongoDB,
                Server = p.Srv ? new MongoServerAddress(p.Host.Trim()) : new MongoServerAddress(p.Host.Trim(), p.Port),
                UseTls = p.Tls || p.Srv,
                AllowInsecureTls = p.TlsInsecure,
            };
            if (!string.IsNullOrWhiteSpace(p.User))
            {
                u.Username = p.User;
                u.Password = password ?? "";
                u.AuthenticationSource = string.IsNullOrWhiteSpace(p.AuthDatabase) ? null : p.AuthDatabase.Trim();
            }
            if (!string.IsNullOrWhiteSpace(p.AuthMechanism))
            {
                u.AuthenticationMechanism = p.AuthMechanism;
                if (p.AuthMechanism == "MONGODB-X509") { u.Password = null; u.AuthenticationSource = "$external"; }
            }
            if (!string.IsNullOrWhiteSpace(p.ReplicaSet)) u.ReplicaSetName = p.ReplicaSet.Trim();
            if (!p.Srv && p.DirectConnection && string.IsNullOrWhiteSpace(p.ReplicaSet)) u.DirectConnection = true;
            if (Enum.TryParse<ReadPreferenceMode>(p.ReadPreference, true, out var mode)) u.ReadPreference = new ReadPreference(mode);
        }
        var s = MongoClientSettings.FromUrl(u.ToMongoUrl());
        if (tunnelPort != null)
        {
            // Through SSH only the one server behind the tunnel can be reached: never follow the replica set's host list.
            if (s.Scheme == MongoDB.Driver.Core.Configuration.ConnectionStringScheme.MongoDBPlusSrv)
                throw new ApiException("mongodb+srv:// connection strings can't go through an SSH tunnel; use the host and port of one server.");
            s.Server = new MongoServerAddress("127.0.0.1", (int)tunnelPort);
            s.Servers = [s.Server];
            s.DirectConnection = true;
            s.ReplicaSetName = null;
            // The certificate names the real host, not 127.0.0.1.
            if (s.UseTls) s.SslSettings = new SslSettings { ServerCertificateValidationCallback = s.AllowInsecureTls ? (_, _, _, _) => true : null };
        }
        var timeout = TimeSpan.FromSeconds(Math.Clamp(p.ConnectTimeout, 1, 600));
        s.ConnectTimeout = timeout;
        s.ServerSelectionTimeout = timeout;
        s.ApplicationName = "ZawMongo";
        s.MaxConnectionPoolSize = 20;
        return s;
    }

    /// <summary>Where the server is, for the log ("host:port", the SRV name, or the connection string's hosts).</summary>
    public static string Describe(SessionProfile p)
    {
        if (p.Mode == "uri")
        {
            try { return string.Join(", ", new MongoUrl(p.Uri!.Trim()).Servers.Select(s => s.ToString())); }
            catch (Exception) { return "(connection string)"; }
        }
        return p.Srv ? p.Host + " (SRV)" : $"{p.Host}:{p.Port}";
    }

    static string? UserOf(SessionProfile p)
    {
        if (p.Mode != "uri") return string.IsNullOrWhiteSpace(p.User) ? null : p.User;
        try { return new MongoUrl(p.Uri!.Trim()).Username; } catch (Exception) { return null; }
    }

    /// <summary>The database a connection string names (mongodb://host/<b>db</b>), used as the default database.</summary>
    static string? UriDatabase(SessionProfile p)
    {
        if (p.Mode != "uri") return null;
        try { return new MongoUrl(p.Uri!.Trim()).DatabaseName; } catch (Exception) { return null; }
    }

    public async Task<DbSession> ConnectAsync(SessionProfile p, string? password, string? sshSecret, OpLog log, CancellationToken ct)
    {
        var tunnel = p.SshEnabled ? await SshTunnel.OpenAsync(p, sshSecret, log, ct) : null;
        try
        {
            var user = UserOf(p);
            log.Note($"Connecting to {Describe(p)}{(tunnel != null ? " through SSH" : "")}{(user != null ? $" as {user}, using password: {(string.IsNullOrEmpty(password) ? "No" : "Yes")}" : " without authentication")} ...");
            var client = new MongoClient(BuildSettings(p, password, tunnel?.LocalPort));
            var hello = await PingAsync(client, log, ct);
            var s = new DbSession { Id = Guid.NewGuid().ToString("n")[..12], Profile = p, Client = client, Tunnel = tunnel };
            sessions[s.Id] = s;
            log.Note($"Connected.{(hello.TryGetValue("setName", out var rs) ? $" Replica set {rs}," : "")} {(hello.GetValue("isWritablePrimary", hello.GetValue("ismaster", false)).ToBoolean() ? "primary" : "not the primary")}{(p.ReadOnly ? ", read-only mode" : "")}");
            return s;
        }
        catch
        {
            tunnel?.Dispose();
            throw;
        }
    }

    /// <summary>Checks that the server answers (and the credentials work); returns its hello reply.</summary>
    public static async Task<BsonDocument> PingAsync(MongoClient client, OpLog log, CancellationToken ct)
    {
        var admin = client.GetDatabase("admin");
        var hello = await log.Timed("db.hello()", () => admin.RunCommandAsync<BsonDocument>(new BsonDocument("hello", 1), cancellationToken: ct));
        // hello doesn't need authentication; listing databases (or the connection status) proves the credentials.
        await admin.RunCommandAsync<BsonDocument>(new BsonDocument("connectionStatus", 1), cancellationToken: ct);
        return hello;
    }

    /// <summary>Connects with a profile only to check it, then closes the connection.</summary>
    public static async Task<object> TestAsync(SessionProfile p, string? password, string? sshSecret, OpLog log, CancellationToken ct)
    {
        using var tunnel = p.SshEnabled ? await SshTunnel.OpenAsync(p, sshSecret, log, ct) : null;
        log.Note($"Testing connection to {Describe(p)}{(tunnel != null ? " through SSH" : "")}");
        var client = new MongoClient(BuildSettings(p, password, tunnel?.LocalPort));
        try
        {
            await PingAsync(client, log, ct);
            var build = await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("buildInfo", 1), cancellationToken: ct);
            return new { version = build.GetValue("version", "").ToString(), ssh = tunnel != null };
        }
        finally { client.Dispose(); }
    }

    public DbSession? FindByProfile(string profileId) => sessions.Values.FirstOrDefault(s => s.Profile.Id == profileId);

    public DbSession Get(string id) =>
        sessions.TryGetValue(id, out var s) ? s : throw new ApiException("This session is not connected. Open it again from the session manager.");

    public async Task<object> InfoAsync(DbSession s, OpLog log, CancellationToken ct)
    {
        var admin = s.Db("admin");
        var build = await log.Timed("db.getSiblingDB(\"admin\").runCommand({ buildInfo: 1 })", () => admin.RunCommandAsync<BsonDocument>(new BsonDocument("buildInfo", 1), cancellationToken: ct));
        var hello = await admin.RunCommandAsync<BsonDocument>(new BsonDocument("hello", 1), cancellationToken: ct);
        var status = await admin.RunCommandAsync<BsonDocument>(new BsonDocument("connectionStatus", 1), cancellationToken: ct);
        var users = status.GetValue("authInfo", new BsonDocument()).AsBsonDocument.GetValue("authenticatedUsers", new BsonArray()).AsBsonArray;
        var user = users.Count > 0 ? users[0].AsBsonDocument.GetValue("user", "").ToString() : null;
        var topology = hello.Contains("setName") ? "replicaSet" : hello.GetValue("msg", "").ToString() == "isdbgrid" ? "sharded" : "standalone";
        return new
        {
            sid = s.Id,
            profileId = s.Profile.Id,
            name = s.Profile.Name,
            host = Describe(s.Profile),
            user,
            version = build.GetValue("version", "").ToString(),
            enterprise = build.TryGetValue("modules", out var m) && m is BsonArray ma && ma.Contains("enterprise"),
            topology,
            replicaSet = hello.GetValue("setName", BsonNull.Value).IsBsonNull ? null : hello["setName"].ToString(),
            primary = hello.GetValue("isWritablePrimary", hello.GetValue("ismaster", false)).ToBoolean(),
            me = hello.GetValue("me", BsonNull.Value).IsBsonNull ? null : hello["me"].ToString(),
            defaultDatabase = string.IsNullOrWhiteSpace(s.Profile.DefaultDatabase) ? UriDatabase(s.Profile) : s.Profile.DefaultDatabase.Trim(),
            readOnly = s.Profile.ReadOnly,
            color = s.Profile.Color,
            production = s.Profile.Production,
            ssh = s.Profile.SshEnabled ? $"{s.Profile.SshUser}@{s.Profile.SshHost}" : null,
        };
    }

    public Task DisconnectAsync(string id)
    {
        if (!sessions.TryRemove(id, out var s)) return Task.CompletedTask;
        foreach (var cts in s.Running.Values) { try { cts.Cancel(); } catch (ObjectDisposedException) { } }
        s.Client.Dispose();
        s.Tunnel?.Dispose();
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var id in sessions.Keys.ToList())
        {
            try { await DisconnectAsync(id); } catch (Exception) { /* shutting down */ }
        }
    }
}
