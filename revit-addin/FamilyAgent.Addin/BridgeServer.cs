using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace FamilyAgent.Addin
{
    /// <summary>
    /// Local HTTP bridge the studio posts specs to. Revit API work is marshalled onto the
    /// Revit thread through an ExternalEvent.
    /// </summary>
    internal sealed class BridgeServer
    {
        public static readonly BridgeServer Instance = new BridgeServer();

        private static readonly JsonSerializerSettings JsonSettings = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            NullValueHandling = NullValueHandling.Ignore,
        };

        private readonly HttpListener _listener = new HttpListener();
        private readonly BuildRequestHandler _handler = new BuildRequestHandler();
        private readonly InspectRequestHandler _inspector = new InspectRequestHandler();
        private ExternalEvent _externalEvent;
        private ExternalEvent _inspectEvent;
        private Thread _thread;
        private volatile bool _running;

        public bool IsRunning => _running;
        public int Port { get; private set; }

        private BridgeServer()
        {
        }

        public bool Start(int port)
        {
            if (_running) return true;

            try
            {
                _externalEvent = _externalEvent ?? ExternalEvent.Create(_handler);
                _handler.Event = _externalEvent;

                _inspectEvent = _inspectEvent ?? ExternalEvent.Create(_inspector);
                _inspector.Event = _inspectEvent;

                _listener.Prefixes.Clear();
                _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
                _listener.Start();
            }
            catch
            {
                return false;
            }

            Port = port;
            _running = true;
            _thread = new Thread(Loop) { IsBackground = true, Name = "Family Agent bridge" };
            _thread.Start();
            return true;
        }

        public void Stop()
        {
            _running = false;
            try { _listener.Stop(); } catch { }
            try { _listener.Close(); } catch { }
        }

        private void Loop()
        {
            while (_running)
            {
                HttpListenerContext context;
                try
                {
                    context = _listener.GetContext();
                }
                catch
                {
                    break;
                }

                ThreadPool.QueueUserWorkItem(_ => Handle(context));
            }
        }

        private void Handle(HttpListenerContext context)
        {
            try
            {
                var path = context.Request.Url?.AbsolutePath ?? "/";

                if (context.Request.HttpMethod == "GET" && path == "/health")
                {
                    Respond(context, 200, JsonConvert.SerializeObject(new { ok = true, service = "family-agent" }));
                    return;
                }

                if (context.Request.HttpMethod != "POST" || path != "/build")
                {
                    if (context.Request.HttpMethod == "POST" && path == "/inspect")
                    {
                        string inspectBody;
                        using (var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8))
                        {
                            inspectBody = reader.ReadToEnd();
                        }

                        if (!_inspector.TryQueue(inspectBody, context))
                        {
                            Respond(context, 409,
                                JsonConvert.SerializeObject(new { ok = false, error = "Revit is busy with another build" }));
                        }

                        return;
                    }

                    Respond(context, 404, JsonConvert.SerializeObject(new { ok = false, error = "Not found" }));
                    return;
                }

                string body;
                using (var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8))
                {
                    body = reader.ReadToEnd();
                }

                if (string.IsNullOrWhiteSpace(body))
                {
                    Respond(context, 400, JsonConvert.SerializeObject(new { ok = false, error = "Empty body" }));
                    return;
                }

                if (!_handler.TryQueue(body, context))
                {
                    Respond(context, 409,
                        JsonConvert.SerializeObject(new { ok = false, error = "Revit is busy with another build" }));
                }
            }
            catch (Exception ex)
            {
                Respond(context, 500, JsonConvert.SerializeObject(new { ok = false, error = ex.Message }));
            }
        }

        internal static void Respond(HttpListenerContext context, int status, string json)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(json);
                context.Response.StatusCode = status;
                context.Response.ContentType = "application/json; charset=utf-8";
                context.Response.ContentLength64 = bytes.Length;
                context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            }
            catch
            {
                // The studio may have gone away already.
            }
            finally
            {
                try { context.Response.Close(); } catch { }
            }
        }

        internal static string Serialize(BuildResult result)
        {
            return JsonConvert.SerializeObject(result, JsonSettings);
        }

        private sealed class InspectRequestHandler : IExternalEventHandler
        {
            private readonly object _gate = new object();
            private string _json;
            private HttpListenerContext _context;
            private bool _busy;

            public ExternalEvent Event;

            public bool TryQueue(string json, HttpListenerContext context)
            {
                lock (_gate)
                {
                    if (_busy) return false;
                    _busy = true;
                    _json = json;
                    _context = context;
                }

                Event?.Raise();
                return true;
            }

            public void Execute(UIApplication app)
            {
                string json;
                HttpListenerContext context;

                lock (_gate)
                {
                    json = _json;
                    context = _context;
                }

                try
                {
                    var request = JsonConvert.DeserializeObject<InspectRequest>(json) ?? new InspectRequest();
                    var result = FamilyBuilder.Inspect(
                        app,
                        request.Path,
                        request.Parameter,
                        request.Percent <= 0 ? 15 : request.Percent);

                    Respond(context, 200, JsonConvert.SerializeObject(new { ok = true, result }, JsonSettings));
                }
                catch (Exception ex)
                {
                    Respond(context, 500,
                        JsonConvert.SerializeObject(new { ok = false, error = ex.Message }, JsonSettings));
                }
                finally
                {
                    lock (_gate)
                    {
                        _busy = false;
                        _json = null;
                        _context = null;
                    }
                }
            }

            public string GetName() => "Family Agent inspect";

            private sealed class InspectRequest
            {
                public string Path { get; set; }
                public string Parameter { get; set; }
                public double Percent { get; set; }
            }
        }

        private sealed class BuildRequestHandler : IExternalEventHandler
        {
            private readonly object _gate = new object();
            private string _json;
            private HttpListenerContext _context;
            private bool _busy;

            public ExternalEvent Event;

            public bool TryQueue(string json, HttpListenerContext context)
            {
                lock (_gate)
                {
                    if (_busy) return false;
                    _busy = true;
                    _json = json;
                    _context = context;
                }

                Event?.Raise();
                return true;
            }

            public void Execute(UIApplication app)
            {
                string json;
                HttpListenerContext context;

                lock (_gate)
                {
                    json = _json;
                    context = _context;
                }

                try
                {
                    var result = FamilyBuilder.Build(app.Application, json);
                    Respond(context, result.Ok ? 200 : 500, Serialize(result));
                }
                catch (Exception ex)
                {
                    Respond(context, 500,
                        JsonConvert.SerializeObject(new { ok = false, error = ex.Message }, JsonSettings));
                }
                finally
                {
                    lock (_gate)
                    {
                        _busy = false;
                        _json = null;
                        _context = null;
                    }
                }
            }

            public string GetName() => "Family Agent build";
        }
    }
}
