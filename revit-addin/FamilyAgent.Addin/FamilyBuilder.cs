using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using FamilyAgent.Core;
using CoreParameterSet = FamilyAgent.Core.ParameterSet;

namespace FamilyAgent.Addin
{
    public sealed class BuildResult
    {
        public bool Ok { get; set; }
        public string Path { get; set; }
        public string RevitVersion { get; set; }
        public List<string> Warnings { get; set; } = new List<string>();
        public string Error { get; set; }
        public object Stats { get; set; }
    }

    internal static class FamilyBuilder
    {
        private const double MmPerFoot = 304.8;
        private const double DegToRad = Math.PI / 180.0;

        public static BuildResult Build(Application app, string json)
        {
            var started = DateTime.UtcNow;
            var result = new BuildResult { RevitVersion = app.VersionNumber };
            Document document = null;

            try
            {
                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);
                result.Warnings.AddRange(model.Warnings);

                if (model.Parts.Count == 0)
                    throw new InvalidOperationException(
                        "No geometry could be resolved from the spec. " + string.Join(" ", model.Warnings));

                var template = TemplateCatalog.Resolve(app, spec);
                document = app.NewFamilyDocument(template);

                using (var transaction = new Transaction(document, "Family Agent — build family"))
                {
                    transaction.Start();

                    var manager = document.FamilyManager;
                    CreateFamilyType(manager, spec);
                    CreateParameters(document, manager, parameters, result.Warnings);
                    var created = CreateGeometry(document, model, result.Warnings);

                    transaction.Commit();

                    result.Stats = new
                    {
                        parts = model.Parts.Count,
                        instances = model.Instances,
                        solids = created,
                        parameters = parameters.Ordered.Count,
                        bounds = new
                        {
                            x = Math.Round(model.Bounds.Size.X),
                            y = Math.Round(model.Bounds.Size.Y),
                            z = Math.Round(model.Bounds.Size.Z),
                        },
                        elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                    };
                }

                var directory = OutputDirectory();
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, Slug(spec.Name) + ".rfa");

                document.SaveAs(path, new SaveAsOptions { OverwriteExistingFile = true, MaximumBackups = 1 });
                result.Path = path;
                result.Ok = true;
            }
            catch (Exception ex)
            {
                result.Ok = false;
                result.Error = ex.Message;
            }
            finally
            {
                if (document != null)
                {
                    try { document.Close(false); }
                    catch { /* leave the document open rather than lose the result */ }
                }
            }

            return result;
        }

        // ------------------------------------------------------------ parameters

        private static void CreateFamilyType(FamilyManager manager, FamilySpec spec)
        {
            if (string.IsNullOrWhiteSpace(spec.TypeName)) return;

            try
            {
                var type = manager.NewType(spec.TypeName.Trim());
                manager.CurrentType = type;
            }
            catch
            {
                // The template may already contain a type with that name.
            }
        }

        private static void CreateParameters(
            Document document,
            FamilyManager manager,
            CoreParameterSet parameters,
            List<string> warnings)
        {
            foreach (var parameter in parameters.Ordered)
            {
                if (!string.IsNullOrEmpty(parameter.Error))
                {
                    warnings.Add($"Parameter \"{parameter.Name}\" skipped: {parameter.Error}");
                    continue;
                }

                try
                {
                    var familyParameter = manager.AddParameter(
                        parameter.Name,
                        GroupFor(parameter.Group),
                        SpecFor(parameter.Type),
                        parameter.Instance);

                    if (familyParameter == null)
                    {
                        warnings.Add($"Parameter \"{parameter.Name}\" was not created by Revit");
                        continue;
                    }

                    ApplyValue(manager, familyParameter, parameter, warnings);
                }
                catch (Exception ex)
                {
                    warnings.Add($"Parameter \"{parameter.Name}\" was not created: {ex.Message}");
                }
            }
        }

        private static void ApplyValue(
            FamilyManager manager,
            Autodesk.Revit.DB.FamilyParameter target,
            ResolvedParameter parameter,
            List<string> warnings)
        {
            if (!string.IsNullOrWhiteSpace(parameter.Formula))
            {
                try
                {
                    manager.SetFormula(target, parameter.Formula);
                    return;
                }
                catch (Exception ex)
                {
                    warnings.Add(
                        $"Formula on \"{parameter.Name}\" was rejected ({ex.Message}); the computed value was used instead.");
                }
            }

            try
            {
                if (parameter.Text != null)
                {
                    manager.Set(target, parameter.Text);
                    return;
                }

                if (parameter.YesNo.HasValue)
                {
                    manager.Set(target, parameter.YesNo.Value ? 1 : 0);
                    return;
                }

                if (!parameter.Number.HasValue) return;
                var value = parameter.Number.Value;

                if (IsType(parameter.Type, "Length"))
                {
                    manager.Set(target, value / MmPerFoot);
                }
                else if (IsType(parameter.Type, "Angle"))
                {
                    manager.Set(target, value * DegToRad);
                }
                else if (IsType(parameter.Type, "Integer"))
                {
                    manager.Set(target, (int)Math.Round(value));
                }
                else
                {
                    manager.Set(target, value);
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"Value for \"{parameter.Name}\" was rejected: {ex.Message}");
            }
        }

        private static ForgeTypeId GroupFor(string group)
        {
            switch ((group ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "dimensions": return GroupTypeId.Length;
                case "constraints": return GroupTypeId.Constraints;
                case "identity data": return GroupTypeId.IdentityData;
                case "graphics": return GroupTypeId.Graphics;
                case "materials and finishes": return GroupTypeId.Materials;
                case "mechanical": return GroupTypeId.Mechanical;
                case "electrical": return GroupTypeId.Electrical;
                case "plumbing": return GroupTypeId.Plumbing;
                case "energy analysis": return GroupTypeId.EnergyAnalysis;
                case "structural": return GroupTypeId.Structural;
                case "construction": return GroupTypeId.Construction;
                case "visibility": return GroupTypeId.Visibility;
                case "fire protection": return GroupTypeId.FireProtection;
                case "general": return GroupTypeId.General;
                case "data": return GroupTypeId.Data;
                default: return GroupTypeId.Data;
            }
        }

        private static ForgeTypeId SpecFor(string type)
        {
            switch ((type ?? "Length").Trim().ToLowerInvariant())
            {
                case "angle": return SpecTypeId.Angle;
                case "number": return SpecTypeId.Number;
                case "integer": return SpecTypeId.Int.Integer;
                case "text": return SpecTypeId.String.Text;
                case "yesno": return SpecTypeId.Boolean.YesNo;
                default: return SpecTypeId.Length;
            }
        }

        private static bool IsType(string type, string expected) =>
            string.Equals(type ?? string.Empty, expected, StringComparison.OrdinalIgnoreCase);

        // -------------------------------------------------------------- geometry

        private static int CreateGeometry(Document document, ResolvedModel model, List<string> warnings)
        {
            var created = 0;

            foreach (var part in model.Parts)
            {
                try
                {
                    var body = BuildSolid(part.Solid);
                    if (body == null)
                    {
                        warnings.Add($"Part \"{part.Id}\" produced no solid");
                        continue;
                    }

                    foreach (var cut in part.Cuts)
                    {
                        try
                        {
                            var cutter = BuildSolid(cut);
                            if (cutter == null) continue;
                            body = BooleanOperationsUtils.ExecuteBooleanOperation(
                                body, cutter, BooleanOperationsType.Difference);
                        }
                        catch (Exception ex)
                        {
                            warnings.Add($"Cut on \"{part.Id}\" failed: {ex.Message}");
                        }
                    }

                    if (body == null || body.Volume <= 0)
                    {
                        warnings.Add($"Part \"{part.Id}\" has no volume after boolean cuts");
                        continue;
                    }

                    for (var index = 0; index < Math.Max(1, part.ArrayCount); index += 1)
                    {
                        var clone = index == 0
                            ? body
                            : SolidUtils.CreateTransformed(body, Transform.CreateTranslation(ArrayOffset(part, index)));

                        var element = FreeFormElement.Create(document, clone);
                        if (element == null) continue;

                        try
                        {
                            element.Name = part.ArrayCount > 1 ? $"{part.Name} {index + 1}" : part.Name;
                        }
                        catch
                        {
                            // Free form elements do not always accept a name.
                        }

                        AssignMaterial(document, element, part.Material, warnings);
                        created += 1;
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add($"Part \"{part.Id}\" failed: {ex.Message}");
                }
            }

            return created;
        }

        private static XYZ ArrayOffset(ResolvedPart part, int index)
        {
            var distance = Ft(part.ArraySpacing * index);
            switch (part.ArrayAxis)
            {
                case "y": return new XYZ(0, distance, 0);
                case "z": return new XYZ(0, 0, distance);
                default: return new XYZ(distance, 0, 0);
            }
        }

        private static Solid BuildSolid(ResolvedSolid solid)
        {
            switch (solid.Kind)
            {
                case "box": return BuildBox(solid);
                case "cylinder": return BuildCylinder(solid);
                case "prism": return BuildPrism(solid);
                default: return null;
            }
        }

        private static Solid BuildBox(ResolvedSolid solid)
        {
            var width = Ft(Math.Abs(solid.Size.X));
            var depth = Ft(Math.Abs(solid.Size.Y));
            var height = Ft(Math.Abs(solid.Size.Z));

            if (width <= 0 || depth <= 0 || height <= 0)
                throw new InvalidOperationException("box has a zero dimension");

            var profile = RectLoop(new XYZ(-width / 2, -depth / 2, 0), width, depth);
            Solid result = GeometryCreationUtilities.CreateExtrusionGeometry(
                new List<CurveLoop> { profile }, XYZ.BasisZ, height);

            if (Math.Abs(solid.RotationZ) > 1e-9)
            {
                result = SolidUtils.CreateTransformed(
                    result, Transform.CreateRotation(XYZ.BasisZ, solid.RotationZ * DegToRad));
            }

            var z = solid.Size.Z >= 0 ? solid.Origin.Z : solid.Origin.Z + solid.Size.Z;
            return SolidUtils.CreateTransformed(
                result, Transform.CreateTranslation(new XYZ(Ft(solid.Origin.X), Ft(solid.Origin.Y), Ft(z))));
        }

        private static Solid BuildCylinder(ResolvedSolid solid)
        {
            var radius = Ft(solid.Radius);
            var length = Ft(Math.Abs(solid.Height));
            if (radius <= 0 || length <= 0) throw new InvalidOperationException("cylinder has a zero dimension");

            XYZ normal, u, v;
            Basis(solid.Axis, out normal, out u, out v);

            var direction = solid.Height >= 0 ? normal : -normal;
            var center = ToXyz(solid.Base);

            var profile = CircleLoop(center, radius, u, v, solid.Segments);
            Solid result = GeometryCreationUtilities.CreateExtrusionGeometry(
                new List<CurveLoop> { profile }, direction, length);

            if (solid.InnerRadius > 0)
            {
                var innerCenter = center - direction * Ft(0.6);
                var innerProfile = CircleLoop(innerCenter, Ft(solid.InnerRadius), u, v, solid.Segments);
                var inner = GeometryCreationUtilities.CreateExtrusionGeometry(
                    new List<CurveLoop> { innerProfile }, direction, length + Ft(1.2));
                result = BooleanOperationsUtils.ExecuteBooleanOperation(
                    result, inner, BooleanOperationsType.Difference);
            }

            return result;
        }

        private static Solid BuildPrism(ResolvedSolid solid)
        {
            var length = Ft(Math.Abs(solid.To - solid.From));
            if (length <= 0) throw new InvalidOperationException("prism has a zero depth");

            XYZ u, v, start;
            XYZ direction;

            switch (solid.Plane)
            {
                case "xz":
                    u = XYZ.BasisX;
                    v = XYZ.BasisZ;
                    start = new XYZ(0, Ft(solid.From), 0);
                    direction = XYZ.BasisY;
                    break;
                case "yz":
                    u = XYZ.BasisY;
                    v = XYZ.BasisZ;
                    start = new XYZ(Ft(solid.From), 0, 0);
                    direction = XYZ.BasisX;
                    break;
                default:
                    u = XYZ.BasisX;
                    v = XYZ.BasisY;
                    start = new XYZ(0, 0, Ft(solid.From));
                    direction = XYZ.BasisZ;
                    break;
            }

            if (solid.To < solid.From) direction = -direction;

            var points = new List<XYZ>();
            foreach (var point in solid.Points)
            {
                points.Add(start + u * Ft(point.A) + v * Ft(point.B));
            }

            if (points.Count < 3) throw new InvalidOperationException("prism needs at least 3 points");

            var loop = Loop(points);
            return GeometryCreationUtilities.CreateExtrusionGeometry(
                new List<CurveLoop> { loop }, direction, length);
        }

        private static void Basis(string axis, out XYZ normal, out XYZ u, out XYZ v)
        {
            switch (axis)
            {
                case "x":
                    normal = XYZ.BasisX;
                    u = XYZ.BasisY;
                    v = XYZ.BasisZ;
                    return;
                case "y":
                    normal = XYZ.BasisY;
                    u = XYZ.BasisZ;
                    v = XYZ.BasisX;
                    return;
                default:
                    normal = XYZ.BasisZ;
                    u = XYZ.BasisX;
                    v = XYZ.BasisY;
                    return;
            }
        }

        private static CurveLoop RectLoop(XYZ center, double width, double depth)
        {
            var halfWidth = width / 2;
            var halfDepth = depth / 2;

            return Loop(new List<XYZ>
            {
                new XYZ(center.X - halfWidth, center.Y - halfDepth, center.Z),
                new XYZ(center.X + halfWidth, center.Y - halfDepth, center.Z),
                new XYZ(center.X + halfWidth, center.Y + halfDepth, center.Z),
                new XYZ(center.X - halfWidth, center.Y + halfDepth, center.Z),
            });
        }

        private static CurveLoop CircleLoop(XYZ center, double radius, XYZ u, XYZ v, int segments)
        {
            var count = Math.Max(12, segments);
            var points = new List<XYZ>(count);
            for (var i = 0; i < count; i += 1)
            {
                var angle = 2 * Math.PI * i / count;
                points.Add(center + u * (Math.Cos(angle) * radius) + v * (Math.Sin(angle) * radius));
            }
            return Loop(points);
        }

        private static CurveLoop Loop(IList<XYZ> points)
        {
            var loop = new CurveLoop();
            for (var i = 0; i < points.Count; i += 1)
            {
                loop.Append(Line.CreateBound(points[i], points[(i + 1) % points.Count]));
            }
            return loop;
        }

        // ------------------------------------------------------------- materials

        private static void AssignMaterial(Document document, Element element, string name, List<string> warnings)
        {
            if (string.IsNullOrWhiteSpace(name)) return;

            try
            {
                var material = FindOrCreateMaterial(document, name, warnings);
                if (material == null) return;

                var parameter = element.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM);
                if (parameter == null || parameter.IsReadOnly) return;
                parameter.Set(material.Id);
            }
            catch (Exception ex)
            {
                warnings.Add($"Material \"{name}\": {ex.Message}");
            }
        }

        private static Material FindOrCreateMaterial(Document document, string name, List<string> warnings)
        {
            var existing = new FilteredElementCollector(document)
                .OfClass(typeof(Material))
                .Cast<Material>()
                .FirstOrDefault(material => string.Equals(material.Name, name, StringComparison.OrdinalIgnoreCase));
            if (existing != null) return existing;

            try
            {
                var id = Material.Create(document, name);
                return document.GetElement(id) as Material;
            }
            catch (Exception ex)
            {
                warnings.Add($"Material \"{name}\" could not be created: {ex.Message}");
                return null;
            }
        }

        // ------------------------------------------------------------- utilities

        private static double Ft(double millimeters) => millimeters / MmPerFoot;

        private static XYZ ToXyz(Vec3d point) => new XYZ(Ft(point.X), Ft(point.Y), Ft(point.Z));

        public static string OutputDirectory()
        {
            var configured = Environment.GetEnvironmentVariable("FAMILY_AGENT_OUT");
            if (!string.IsNullOrWhiteSpace(configured)) return configured;

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "FamilyAgent", "out");
        }

        public static string QueueDirectory()
        {
            var configured = Environment.GetEnvironmentVariable("FAMILY_QUEUE_DIR");
            if (!string.IsNullOrWhiteSpace(configured)) return configured;

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "FamilyAgent", "queue");
        }

        private static string Slug(string name)
        {
            var builder = new StringBuilder();
            foreach (var ch in (name ?? "family").ToLowerInvariant())
            {
                if (char.IsLetterOrDigit(ch)) builder.Append(ch);
                else if (builder.Length > 0 && builder[builder.Length - 1] != '-') builder.Append('-');
            }

            var slug = builder.ToString().Trim('-');
            if (slug.Length == 0) slug = "family";
            return slug.Length > 80 ? slug.Substring(0, 80) : slug;
        }
    }
}
