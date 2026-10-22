using System.Diagnostics;
using System.Text.Json;

// Chrome's native messaging launcher only. No browser or desktop process control.
var config = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "host-config.json"))).RootElement;
if (args.Length == 0 || args[0] != config.GetProperty("origin").GetString()) return 1;
var start = new ProcessStartInfo(config.GetProperty("node").GetString()!) {
    UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true,
    RedirectStandardError = true, CreateNoWindow = true
};
start.ArgumentList.Add(config.GetProperty("script").GetString()!);
start.ArgumentList.Add("--origin"); start.ArgumentList.Add(args[0]);
start.ArgumentList.Add("--port"); start.ArgumentList.Add(config.GetProperty("port").GetInt32().ToString());
if (config.TryGetProperty("dataDir", out var dataDir) && !string.IsNullOrWhiteSpace(dataDir.GetString()))
    start.Environment["HEXIGRID_DATA_DIR"] = Path.GetFullPath(dataDir.GetString()!);
using var child = Process.Start(start)!;
var input = Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream);
var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
// Do not forward private error details into Chrome or transcripts.
var errors = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
await Task.WhenAny(input, child.WaitForExitAsync());
child.StandardInput.Close();
await child.WaitForExitAsync(); await output; await errors;
return child.ExitCode;
