using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace ApexHarnessDesktop
{
    static class Program
    {
        private static readonly string ProjectRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        private static readonly string ServerEntry = Path.Combine(ProjectRoot, "server", "apex-app-server.ts");
        private static readonly string ServerUrl = "http://127.0.0.1:5199";
        private static readonly string HealthUrl = "http://127.0.0.1:5199/api/bootstrap";
        private static readonly string LogDir = Path.Combine(ProjectRoot, "data", "logs");

        [STAThread]
        static void Main(string[] args)
        {
            bool daemonOnly = false;
            foreach (string arg in args)
            {
                if (string.Equals(arg, "--daemon-only", StringComparison.OrdinalIgnoreCase))
                {
                    daemonOnly = true;
                }
            }

            try
            {
                Directory.CreateDirectory(LogDir);
            }
            catch { }

            if (!IsBackendHealthy())
            {
                StartDetachedBackend();
                for (int i = 0; i < 45; i++)
                {
                    if (IsBackendHealthy()) break;
                    Thread.Sleep(250);
                }
            }

            if (!daemonOnly)
            {
                OpenStandaloneAppWindow();
            }
        }

        private static bool IsBackendHealthy()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(HealthUrl);
                req.Timeout = 1000;
                req.ReadWriteTimeout = 1000;
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

        private static void StartDetachedBackend()
        {
            string nodeBin = ResolveNodeBinary();
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = nodeBin,
                Arguments = "--experimental-strip-types \"" + ServerEntry + "\"",
                WorkingDirectory = ProjectRoot,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            psi.EnvironmentVariables["APEX_PORT"] = "5199";
            psi.EnvironmentVariables["APEX_PROJECT_ROOT"] = ProjectRoot;
            Process.Start(psi);
        }

        private static void OpenStandaloneAppWindow()
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
                        Arguments = "--app=" + ServerUrl + " --window-size=1480,920",
                        UseShellExecute = true
                    };
                    Process.Start(psi);
                    return;
                }
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = ServerUrl,
                UseShellExecute = true
            });
        }
    }
}
