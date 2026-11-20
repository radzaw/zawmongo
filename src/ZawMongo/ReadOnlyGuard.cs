using MongoDB.Bson;

namespace ZawMongo;

/// <summary>
/// Decides whether a shell statement or a database command only reads. Read-only sessions run nothing else; MongoDB
/// has no read-only connection mode, so this list is the whole protection (together with the endpoints that change
/// data refusing read-only sessions).
/// </summary>
public static class ReadOnlyGuard
{
    static readonly HashSet<string> ReadCollectionMethods =
    [
        "find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "count", "distinct", "getIndexes",
        "getIndexKeys", "getIndexSpecs", "indexes", "stats", "dataSize", "storageSize", "totalIndexSize", "totalSize", "isCapped",
        "getName", "getFullName", "latencyStats", "exists",
    ];

    static readonly HashSet<string> ReadDbMethods =
    [
        "getCollectionNames", "getCollectionInfos", "stats", "getName", "version", "serverStatus", "hostInfo", "serverBuildInfo",
        "currentOp", "getUsers", "getUser", "getRoles", "getRole", "getProfilingStatus", "listCommands", "isMaster", "hello",
        "aggregate", "runCommand", "adminCommand",
    ];

    /// <summary>Commands that never change data or server state (compared ignoring case).</summary>
    static readonly HashSet<string> ReadCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "find", "aggregate", "count", "distinct", "listCollections", "listDatabases", "listIndexes", "collStats", "dbStats",
        "dataSize", "serverStatus", "buildInfo", "hostInfo", "ping", "isMaster", "hello", "connectionStatus", "currentOp",
        "getParameter", "getCmdLineOpts", "replSetGetStatus", "replSetGetConfig", "usersInfo", "rolesInfo", "explain", "getLog",
        "top", "listCommands", "whatsmyuri", "getMore", "killCursors", "validate", "dbHash", "features", "getDefaultRWConcern",
        "connPoolStats", "lockInfo", "listShards", "balancerStatus", "getShardMap", "hostInfo", "getFreeMonitoringStatus",
        "listSearchIndexes", "getClusterParameter", "getLastError", "logout",
    };

    /// <summary>Why a statement isn't allowed in a read-only session, or null when it only reads.</summary>
    public static string? Check(ShellCommand c)
    {
        switch (c.Kind)
        {
            case ShellKind.Use:
            case ShellKind.Show:
                return null;
            case ShellKind.Db:
                if (!ReadDbMethods.Contains(c.Method)) return $"db.{c.Method}() changes the server.";
                if (c.Method is "runCommand" or "adminCommand")
                    return c.ArgAt(0) switch
                    {
                        BsonDocument d => CheckCommand(d),
                        BsonString s => CheckCommand(new BsonDocument(s.Value, 1)),
                        _ => "runCommand() needs a command document.",
                    };
                if (c.Method == "aggregate") return CheckPipeline(c.ArgAt(0));
                return null;
            default:
                if (c.Explain != null && c.Method is "find" or "aggregate" or "count" or "countDocuments" or "distinct") return CheckPipelineIfAggregate(c);
                if (!ReadCollectionMethods.Contains(c.Method)) return $"{c.Method}() changes data.";
                if (c.Chain.Any(x => x.Name is "forEach" or "map")) return "JavaScript callbacks are not supported.";
                return CheckPipelineIfAggregate(c);
        }
    }

    static string? CheckPipelineIfAggregate(ShellCommand c) => c.Method == "aggregate" ? CheckPipeline(c.ArgAt(0)) : null;

    /// <summary>Refuses pipelines that write ($out, $merge), including inside $facet / $lookup / $unionWith.</summary>
    public static string? CheckPipeline(BsonValue? pipeline)
    {
        if (pipeline is not BsonArray stages) return null;
        foreach (var s in stages.OfType<BsonDocument>())
        {
            foreach (var e in s.Elements)
            {
                if (e.Name is "$out" or "$merge") return $"An aggregation with {e.Name} writes to a collection.";
                if (e.Value is BsonDocument inner)
                {
                    if (inner.TryGetValue("pipeline", out var p) && CheckPipeline(p) is { } r1) return r1;
                    if (e.Name == "$facet")
                        foreach (var f in inner.Elements)
                            if (CheckPipeline(f.Value) is { } r2) return r2;
                }
            }
        }
        return null;
    }

    /// <summary>Why a database command isn't allowed in a read-only session, or null when it only reads.</summary>
    public static string? CheckCommand(BsonDocument cmd)
    {
        if (cmd.ElementCount == 0) return "Empty command.";
        var name = cmd.GetElement(0).Name;
        if (!ReadCommands.Contains(name)) return $"The {name} command is not allowed in a read-only session.";
        if (name.Equals("aggregate", StringComparison.OrdinalIgnoreCase) && cmd.TryGetValue("pipeline", out var p)) return CheckPipeline(p);
        if (name.Equals("explain", StringComparison.OrdinalIgnoreCase) && cmd.GetValue(0) is BsonDocument inner) return CheckCommand(inner);
        return null;
    }
}
