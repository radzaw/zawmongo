using MongoDB.Driver;

namespace ZawMongo.Tests.Infrastructure;

/// <summary>
/// Integration tests run against a real MongoDB server named by ZAWMONGO_TEST_URI
/// (for example mongodb://127.0.0.1:27017/?directConnection=true). Each test class works in its own database.
/// </summary>
public static class TestServer
{
    public static string? Uri => Environment.GetEnvironmentVariable("ZAWMONGO_TEST_URI");
    public static bool Enabled => !string.IsNullOrWhiteSpace(Uri);

    /// <summary>A profile for the test server, as the session manager would send it.</summary>
    public static object Profile(bool readOnly = false, string name = "test") => new { name, mode = "uri", uri = Uri, readOnly };

    public static MongoClient Client() => new(Uri);

    public static string NewDatabase() => "zawmongo_test_" + Guid.NewGuid().ToString("n")[..8];
}

/// <summary>A test that needs a MongoDB server; skipped when ZAWMONGO_TEST_URI is not set.</summary>
public sealed class MongoFactAttribute : FactAttribute
{
    public MongoFactAttribute()
    {
        if (!TestServer.Enabled) Skip = "Set ZAWMONGO_TEST_URI to run integration tests.";
    }
}
