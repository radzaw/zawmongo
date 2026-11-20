using System.Diagnostics;

namespace ZawMongo;

public sealed class ApiException(string message) : Exception(message);

/// <summary>Collects the commands run while serving one request, shown in the UI's log panel.</summary>
public sealed class OpLog
{
    public List<string> Items { get; } = [];
    /// <summary>When each item was logged (Unix time in milliseconds), for the timestamps in the UI's log.</summary>
    public List<long> Times { get; } = [];
    /// <summary>How long each command took, from sending it until its results were read (ms); null for comments.
    /// Drives the slow command markers in the UI's log.</summary>
    public List<double?> Ms { get; } = [];
    readonly List<long> starts = [];

    /// <summary>Adds a line and returns its index, to pass to <see cref="Finish"/> once the command is done.</summary>
    public int Add(string line)
    {
        lock (Items)
        {
            Items.Add(line);
            Times.Add(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Ms.Add(null);
            starts.Add(Stopwatch.GetTimestamp());
            return Items.Count - 1;
        }
    }

    /// <summary>Adds a comment line (no duration).</summary>
    public void Note(string text) => Add($"/* {text.Replace("*/", "* /")} */");

    /// <summary>Records how long the command logged at <paramref name="line"/> took (only the first call counts).</summary>
    public void Finish(int line)
    {
        lock (Items)
        {
            if (line < 0 || line >= Ms.Count || Ms[line] != null || starts[line] == 0) return;
            Ms[line] = Math.Round(Stopwatch.GetElapsedTime(starts[line]).TotalMilliseconds, 1);
        }
    }

    /// <summary>Logs <paramref name="line"/>, runs <paramref name="body"/> and records its duration.</summary>
    public async Task<T> Timed<T>(string? line, Func<Task<T>> body)
    {
        var i = line == null ? -1 : Add(line);
        try { return await body(); }
        finally { Finish(i); }
    }
}
