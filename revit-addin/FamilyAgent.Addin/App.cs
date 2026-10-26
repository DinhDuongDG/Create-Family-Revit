using System;
using System.IO;
using System.Reflection;
using Autodesk.Revit.UI;

namespace FamilyAgent.Addin
{
    public sealed class App : IExternalApplication
    {
        public Result OnStartup(UIControlledApplication application)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveLocalAssembly;

            CreateRibbon(application);

            if (!string.Equals(
                    Environment.GetEnvironmentVariable("FAMILY_AGENT_BRIDGE"),
                    "0",
                    StringComparison.OrdinalIgnoreCase))
            {
                BridgeServer.Instance.Start(Commands.BridgePort());
            }

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            BridgeServer.Instance.Stop();
            return Result.Succeeded;
        }

        private static Assembly ResolveLocalAssembly(object sender, ResolveEventArgs args)
        {
            try
            {
                var name = new AssemblyName(args.Name).Name;
                var directory = Path.GetDirectoryName(typeof(App).Assembly.Location);
                if (directory == null) return null;

                var candidate = Path.Combine(directory, name + ".dll");
                return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
            }
            catch
            {
                return null;
            }
        }

        private static void CreateRibbon(UIControlledApplication application)
        {
            const string tabName = "Family Agent";

            try
            {
                application.CreateRibbonTab(tabName);
            }
            catch
            {
                // The tab is already there when Revit reloads an add-in.
            }

            var panel = application.CreateRibbonPanel(tabName, "Build");
            var assemblyPath = typeof(App).Assembly.Location;

            var buildFile = new PushButtonData(
                "FamilyAgentBuildFile",
                "Build from\nfile…",
                assemblyPath,
                "FamilyAgent.Addin.Commands.BuildFromFileCommand")
            {
                ToolTip = "Build a .rfa from a family spec JSON file.",
                LongDescription =
                    "Loads a spec produced by the Family Agent studio and builds the family in Revit.",
            };

            var buildPending = new PushButtonData(
                "FamilyAgentBuildPending",
                "Build\npending",
                assemblyPath,
                "FamilyAgent.Addin.Commands.BuildPendingCommand")
            {
                ToolTip = "Build the newest family spec queued by the studio.",
            };

            var bridge = new PushButtonData(
                "FamilyAgentBridge",
                "Studio\nbridge",
                assemblyPath,
                "FamilyAgent.Addin.Commands.ToggleBridgeCommand")
            {
                ToolTip = "Start or stop the local studio bridge (127.0.0.1:8765).",
            };

            panel.AddItem(buildFile);
            panel.AddItem(buildPending);
            panel.AddSeparator();
            panel.AddItem(bridge);
        }
    }
}
