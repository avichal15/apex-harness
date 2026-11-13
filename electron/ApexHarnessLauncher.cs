using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

namespace ApexHarnessDesktop
{
    static class Program
    {
        private static string ResolveProjectRoot()
        {
            string envRoot = Environment.GetEnvironmentVariable("APEX_PROJECT_ROOT");
            if (!string.IsNullOrWhiteSpace(envRoot) && Directory.Exists(envRoot))
            {
                return envRoot.TrimEnd('\\', '/');
            }
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            return baseDir;
        }

        private static string ResolvePort()
        {
            string envPort = Environment.GetEnvironmentVariable("APEX_PORT");
            if (!string.IsNullOrWhiteSpace(envPort)) return envPort.Trim();
            return "5199";
        }

        [STAThread]
        static int Main(string[] args)
        {
            bool daemonOnly = false;
            bool smokeTest = false;
            foreach (string arg in args)
            {
                if (string.Equals(arg, "--daemon-only", StringComparison.OrdinalIgnoreCase))
                {
                    daemonOnly = true;
                }
                if (string.Equals(arg, "--smoke-test", StringComparison.OrdinalIgnoreCase))
                {
                    smokeTest = true;
                    daemonOnly = true;
                }
            }

            string projectRoot = ResolveProjectRoot();
            string serverEntry = Path.Combine(projectRoot, "server", "apex-app-server.ts");
            string port = ResolvePort();
            string serverUrl = "http://127.0.0.1:" + port;
            string healthUrl = serverUrl + "/";
            string logDir = Path.Combine(projectRoot, "data", "logs");

            try
            {
                Directory.CreateDirectory(logDir);
            }
            catch { }

            if (!IsBackendHealthy(healthUrl))
            {
                StartDetachedBackend(projectRoot, serverEntry, port);
                for (int i = 0; i < 45; i++)
                {
                    if (IsBackendHealthy(healthUrl)) break;
                    Thread.Sleep(250);
                }
            }

            bool healthy = IsBackendHealthy(healthUrl);
            if (smokeTest)
            {
                Console.WriteLine("SMOKE_OK=" + (healthy ? "true" : "false") + ";ROOT=" + projectRoot + ";URL=" + serverUrl);
                return healthy ? 0 : 1;
            }

            if (!daemonOnly)
            {
                OpenStandaloneAppWindow(serverUrl);
            }
            return healthy ? 0 : 1;
        }

        private static bool IsBackendHealthy(string healthUrl)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(healthUrl);
                req.Timeout = 1200;
                req.ReadWriteTimeout = 1200;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static string ResolveNodeBinary()
        {
            string[] candidates = new string[]
            {
                @"C:\Program Files\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                "node.exe"
            };
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate)) return candidate;
            }
            return "node.exe";
        }

        private static void StartDetachedBackend(string projectRoot, string serverEntry, string port)
        {
            string nodeBin = ResolveNodeBinary();
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = nodeBin,
                Arguments = "--experimental-strip-types \"" + serverEntry + "\"",
                WorkingDirectory = projectRoot,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            psi.EnvironmentVariables["APEX_PORT"] = port;
            psi.EnvironmentVariables["APEX_APP_PORT"] = port;
            psi.EnvironmentVariables["APEX_PROJECT_ROOT"] = projectRoot;
            Process.Start(psi);
        }

        private static void OpenStandaloneAppWindow(string serverUrl)
        {
            string[] browsers = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            foreach (string browser in browsers)
            {
                if (File.Exists(browser))
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = browser,
                        Arguments = "--app=" + serverUrl + " --window-size=1480,920",
                        UseShellExecute = true
                    };
                    Process.Start(psi);
                    return;
                }
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = serverUrl,
                UseShellExecute = true
            });
        }
    }
}
