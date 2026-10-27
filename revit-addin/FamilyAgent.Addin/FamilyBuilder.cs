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
            var stage = "reading the spec";
            var buildFailures = new FailureCollector();

            try
            {
                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);
                var materials = MaterialLookup(spec);
                result.Warnings.AddRange(model.Warnings);

                if (model.Parts.Count == 0)
                    throw new InvalidOperationException(
                        "No geometry could be resolved from the spec. " + string.Join(" ", model.Warnings));

                stage = "opening the family template";
                var template = TemplateCatalog.Resolve(app, spec);
                document = app.NewFamilyDocument(template);

                PlaneSkeleton skeleton;
                List<Element> forms;

                stage = "building the family";
                using (var transaction = SilentTransaction(document, "Family Agent — build family", buildFailures))
                {
                    transaction.Start();

                    var manager = document.FamilyManager;
                    CreateFamilyType(manager, spec);
                    CreateParameters(document, manager, parameters, result.Warnings);
                    skeleton = CreateReferencePlanes(document, manager, parameters, model, result.Warnings);
                    forms = CreateGeometry(document, model, materials, result.Warnings);

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException(
                            $"Revit rolled the family back ({status}): {string.Join(" ", buildFailures.Messages.Take(5))}");
                    }
                }

                foreach (var message in buildFailures.Messages.Take(5)) result.Warnings.Add(message);

                stage = "dimensioning the reference planes";
                var refDimensions = CreateDimensions(document, skeleton.Dimensions, result.Warnings);

                stage = "locking the geometry to the reference planes";
                var locks = LockGeometry(document, skeleton, forms, result.Warnings);

                result.Stats = new
                {
                    parts = model.Parts.Count,
                    instances = model.Instances,
                    forms = forms.Count(f => f is Extrusion),
                    voids = forms.Count(f => f is Extrusion extrusion && !extrusion.IsSolid),
                    refPlanes = skeleton.Created,
                    refDimensions,
                    locks,
                    parameters = parameters.Ordered.Count,
                    bounds = new
                    {
                        x = Math.Round(model.Bounds.Size.X),
                        y = Math.Round(model.Bounds.Size.Y),
                        z = Math.Round(model.Bounds.Size.Z),
                    },
                    elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                };

                stage = "saving the family";
                PrepareViews(document);

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
                result.Error = $"{stage}: {ex.Message}" +
                               (buildFailures.Messages.Count > 0
                                   ? " (" + string.Join(" ", buildFailures.Messages.Take(3)) + ")"
                                   : string.Empty);
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

        /// <summary>
        /// Templates open their 3D view in hidden line, which makes a solid family read as
        /// a wireframe. Save it shaded so the built family matches the studio preview.
        /// </summary>
        private static void PrepareViews(Document document)
        {
            try
            {
                using (var transaction = new Transaction(document, "Family Agent — prepare views"))
                {
                    transaction.Start();

                    foreach (var view in new FilteredElementCollector(document)
                                 .OfClass(typeof(View3D))
                                 .Cast<View3D>()
                                 .Where(candidate => !candidate.IsTemplate && candidate.CanBePrinted))
                    {
                        view.DisplayStyle = DisplayStyle.ShadingWithEdges;
                        view.DetailLevel = ViewDetailLevel.Fine;
                    }

                    transaction.Commit();
                }
            }
            catch
            {
                // View setup is cosmetic; never fail a build because of it.
            }
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
                    var familyParameter = FindParameter(manager, parameter.Name);

                    if (familyParameter == null)
                    {
                        familyParameter = manager.AddParameter(
                            parameter.Name,
                            GroupFor(parameter.Group),
                            SpecFor(parameter.Type),
                            parameter.Instance);
                    }

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

        private static Autodesk.Revit.DB.FamilyParameter FindParameter(FamilyManager manager, string name)
        {
            foreach (Autodesk.Revit.DB.FamilyParameter parameter in manager.Parameters)
            {
                if (string.Equals(parameter.Definition?.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return parameter;
                }
            }

            return null;
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
                case "dimensions": return GroupTypeId.Geometry;
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

        // --------------------------------------------------------- reference planes

        private enum PlaneAxis
        {
            X,
            Y,
            Z,
        }

        /// <summary>A reference plane that sits at a known coordinate on one axis.</summary>
        private sealed class SkeletonPlane
        {
            public PlaneAxis Axis;
            public double Coordinate;
            public ReferencePlane Plane;
            public bool Drives;
        }

        /// <summary>
        /// Reference planes plus the dimensions that label them. Planes are placed on the
        /// coordinates the model actually occupies, so a face can be locked onto them and the
        /// labelled parameter really drives the solids.
        /// </summary>
        private sealed class PlaneSkeleton
        {
            public View Plan;
            public View Elevation;
            public int Created;
            public readonly List<SkeletonPlane> Planes = new List<SkeletonPlane>();
            public readonly List<PlaneDimension> Dimensions = new List<PlaneDimension>();

            public ReferencePlane Find(PlaneAxis axis, double coordinate)
            {
                foreach (var candidate in Planes)
                {
                    if (candidate.Axis != axis) continue;
                    if (Math.Abs(candidate.Coordinate - coordinate) <= 1.0 / MmPerFoot) return candidate.Plane;
                }

                return null;
            }

            public bool Drives(PlaneAxis axis, double coordinate)
            {
                foreach (var candidate in Planes)
                {
                    if (candidate.Axis != axis || !candidate.Drives) continue;
                    if (Math.Abs(candidate.Coordinate - coordinate) <= 1.0 / MmPerFoot) return true;
                }

                return false;
            }

            public void Register(PlaneAxis axis, double coordinate, ReferencePlane plane, bool drives)
            {
                foreach (var candidate in Planes)
                {
                    if (candidate.Axis != axis) continue;
                    if (Math.Abs(candidate.Coordinate - coordinate) > 1.0 / MmPerFoot) continue;

                    candidate.Drives |= drives;
                    return;
                }

                Planes.Add(new SkeletonPlane
                {
                    Axis = axis,
                    Coordinate = coordinate,
                    Plane = plane,
                    Drives = drives,
                });
            }
        }

        /// <summary>Coordinates the resolved model actually occupies, in millimetres.</summary>
        private sealed class CoordinateSet
        {
            private readonly Dictionary<PlaneAxis, List<double>> _values =
                new Dictionary<PlaneAxis, List<double>>
                {
                    { PlaneAxis.X, new List<double>() },
                    { PlaneAxis.Y, new List<double>() },
                    { PlaneAxis.Z, new List<double>() },
                };

            public void Add(ResolvedSolid solid, Vec3d offset)
            {
                var bounds = GeometryResolver.BoundsOf(solid);
                _values[PlaneAxis.X].Add(bounds.MinX + offset.X);
                _values[PlaneAxis.X].Add(bounds.MaxX + offset.X);
                _values[PlaneAxis.Y].Add(bounds.MinY + offset.Y);
                _values[PlaneAxis.Y].Add(bounds.MaxY + offset.Y);
                _values[PlaneAxis.Z].Add(bounds.MinZ + offset.Z);
                _values[PlaneAxis.Z].Add(bounds.MaxZ + offset.Z);
            }

            public bool Has(PlaneAxis axis, double millimeters)
            {
                foreach (var value in _values[axis])
                {
                    if (Math.Abs(value - millimeters) <= 1) return true;
                }

                return false;
            }
        }

        private static CoordinateSet ModelCoordinates(ResolvedModel model)
        {
            var coordinates = new CoordinateSet();

            foreach (var part in model.Parts)
            {
                for (var index = 0; index < Math.Max(1, part.ArrayCount); index += 1)
                {
                    coordinates.Add(part.Solid, ArrayOffsetMm(part, index));
                }
            }

            return coordinates;
        }

        /// <summary>
        /// Builds the reference-plane skeleton: centre planes, the base level, and one plane
        /// per length parameter sitting on a real face where possible, dimensioned and
        /// labelled so the parameter drives that plane.
        /// </summary>
        private static PlaneSkeleton CreateReferencePlanes(
            Document document,
            FamilyManager manager,
            CoreParameterSet parameters,
            ResolvedModel model,
            List<string> warnings)
        {
            var skeleton = new PlaneSkeleton
            {
                Plan = FindView(document, ViewType.FloorPlan),
                Elevation = FindView(document, ViewType.Elevation),
            };

            if (skeleton.Plan == null && skeleton.Elevation == null) return skeleton;
            skeleton.Plan = skeleton.Plan ?? skeleton.Elevation;
            skeleton.Elevation = skeleton.Elevation ?? skeleton.Plan;

            var extent = Math.Max(Math.Max(model.Bounds.Size.X, model.Bounds.Size.Y), model.Bounds.Size.Z);
            var half = Ft(Math.Max(extent * 0.7, 400));

            var centerX = Ft(model.Bounds.IsValid ? (model.Bounds.MinX + model.Bounds.MaxX) / 2 : 0);
            var centerY = Ft(model.Bounds.IsValid ? (model.Bounds.MinY + model.Bounds.MaxY) / 2 : 0);

            var coordinates = ModelCoordinates(model);
            var labelled = LabelledParameters(document);
            var usedPairs = new HashSet<string>(StringComparer.Ordinal);

            ReferencePlane Add(string name, PlaneAxis axis, double coordinate, View view, bool drives)
            {
                var existing = skeleton.Find(axis, coordinate);
                if (existing != null)
                {
                    skeleton.Register(axis, coordinate, existing, drives);
                    return existing;
                }

                try
                {
                    var plane = FindPlane(document, name) ??
                                AddPlane(document, view, name, axis, coordinate, half);
                    if (plane == null) return null;

                    skeleton.Register(axis, coordinate, plane, drives);
                    skeleton.Created += 1;
                    return plane;
                }
                catch (Exception ex)
                {
                    warnings.Add($"Reference plane \"{name}\": {ex.Message}");
                    return null;
                }
            }

            void Dim(View view, ReferencePlane from, ReferencePlane to, XYZ start, XYZ end,
                Autodesk.Revit.DB.FamilyParameter label)
            {
                if (view == null || from == null || to == null) return;

                var key = $"{from.UniqueId}|{to.UniqueId}|{view.Id}";
                if (!usedPairs.Add(key)) return;

                skeleton.Dimensions.Add(new PlaneDimension(view, from, to, start, end, label));
            }

            var centerLeftRight = Add("Center (Left/Right)", PlaneAxis.X, 0, skeleton.Plan, false);
            var centerFrontBack = Add("Center (Front/Back)", PlaneAxis.Y, 0, skeleton.Plan, false);
            var baseLevel = Add("Ref. Level", PlaneAxis.Z, 0, skeleton.Elevation, false);

            foreach (var parameter in parameters.Ordered)
            {
                if (!IsType(parameter.Type, "Length")) continue;
                if (!string.IsNullOrEmpty(parameter.Error)) continue;
                if (!parameter.Number.HasValue) continue;

                var value = Math.Abs(parameter.Number.Value);
                if (value < 1) continue;

                var familyParameter = FindParameter(manager, parameter.Name);
                var label = familyParameter != null &&
                            !parameter.Instance &&
                            string.IsNullOrWhiteSpace(parameter.Formula) &&
                            labelled.Add(familyParameter.Id)
                    ? familyParameter
                    : null;

                var axis = AxisFor(parameter.Name);

                if (axis == PlaneAxis.Z)
                {
                    var coordinate = Ft(value);
                    var plane = Add(parameter.Name, axis, coordinate, skeleton.Elevation, label != null);
                    if (plane != null)
                    {
                        Dim(skeleton.Elevation, baseLevel, plane, XYZ.Zero, new XYZ(0, 0, coordinate), label);
                    }

                    continue;
                }

                var sign = coordinates.Has(axis, value) ? 1
                    : coordinates.Has(axis, -value) ? -1
                    : 0;

                if (sign != 0)
                {
                    // The parameter measures a real face from the datum: label that face.
                    var coordinate = Ft(sign * value);
                    var plane = Add(parameter.Name, axis, coordinate, skeleton.Plan, label != null);
                    if (plane == null) continue;

                    var datum = axis == PlaneAxis.X ? centerLeftRight : centerFrontBack;
                    var from = axis == PlaneAxis.X
                        ? new XYZ(0, centerY, 0)
                        : new XYZ(centerX, 0, 0);
                    var to = axis == PlaneAxis.X
                        ? new XYZ(coordinate, centerY, 0)
                        : new XYZ(centerX, coordinate, 0);

                    Dim(skeleton.Plan, datum, plane, from, to, label);
                    continue;
                }

                // Otherwise fall back to a symmetric pair around the model centre.
                var center = axis == PlaneAxis.X ? centerX : centerY;
                var lowOffset = center - Ft(value) / 2;
                var highOffset = center + Ft(value) / 2;

                var low = Add(
                    axis == PlaneAxis.X ? $"{parameter.Name} Left" : $"{parameter.Name} Front",
                    axis,
                    lowOffset,
                    skeleton.Plan,
                    label != null);
                var high = Add(
                    axis == PlaneAxis.X ? $"{parameter.Name} Right" : $"{parameter.Name} Back",
                    axis,
                    highOffset,
                    skeleton.Plan,
                    label != null);

                if (low == null || high == null) continue;

                var lowPoint = axis == PlaneAxis.X
                    ? new XYZ(lowOffset, centerY, 0)
                    : new XYZ(centerX, lowOffset, 0);
                var highPoint = axis == PlaneAxis.X
                    ? new XYZ(highOffset, centerY, 0)
                    : new XYZ(centerX, highOffset, 0);

                Dim(skeleton.Plan, low, high, lowPoint, highPoint, label);
            }

            return skeleton;
        }

        /// <summary>
        /// Wraps a transaction so Revit reports failures to us instead of stopping the
        /// build with a modal dialog the bridge can never dismiss.
        /// </summary>
        private static Transaction SilentTransaction(
            Document document,
            string name,
            FailureCollector collector)
        {
            var transaction = new Transaction(document, name);
            var options = transaction.GetFailureHandlingOptions();
            options.SetFailuresPreprocessor(collector);
            options.SetForcedModalHandling(false);
            options.SetClearAfterRollback(true);
            transaction.SetFailureHandlingOptions(options);
            return transaction;
        }

        private sealed class FailureCollector : IFailuresPreprocessor
        {
            public readonly List<string> Messages = new List<string>();

            public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor)
            {
                var result = FailureProcessingResult.Continue;

                foreach (var failure in failuresAccessor.GetFailureMessages())
                {
                    var text = failure.GetDescriptionText();
                    if (!string.IsNullOrWhiteSpace(text) && !Messages.Contains(text))
                        Messages.Add(text);

                    if (failure.GetSeverity() == FailureSeverity.Warning)
                    {
                        failuresAccessor.DeleteWarning(failure);
                        continue;
                    }

                    // A severe error left unresolved would be shown in a modal dialog that the
                    // bridge can never dismiss, hanging Revit. Roll the change back instead and
                    // surface the text as a warning.
                    result = FailureProcessingResult.ProceedWithRollBack;
                }

                return result;
            }
        }

        /// <summary>
        /// Dimensions are created once the planes are committed, so their references are
        /// regenerated, and in a transaction that downgrades Revit's "cannot be ignored"
        /// errors to a rollback instead of a modal dialog that would stall the bridge.
        /// </summary>
        private static int CreateDimensions(
            Document document,
            List<PlaneDimension> pending,
            List<string> warnings)
        {
            if (pending == null || pending.Count == 0) return 0;

            var failures = new FailureCollector();
            var created = 0;

            try
            {
                using (var transaction = SilentTransaction(document, "Family Agent — reference dimensions", failures))
                {
                    transaction.Start();

                    foreach (var dimension in pending)
                    {
                        // One transaction per dimension: a single unsatisfiable constraint then
                        // drops only that dimension instead of the whole skeleton.
                        try
                        {
                            using (var step = new SubTransaction(document))
                            {
                                step.Start();

                                if (!dimension.Create(document, warnings))
                                {
                                    step.RollBack();
                                    continue;
                                }

                                if (step.Commit() == TransactionStatus.Committed) created += 1;
                            }
                        }
                        catch (Exception ex)
                        {
                            warnings.Add($"Dimension \"{dimension.Name}\" was rejected: {ex.Message}");
                        }
                    }

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        warnings.Add(
                            $"Reference dimensions were rolled back ({status}): {string.Join(" ", failures.Messages.Take(3))}");
                        return 0;
                    }
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"Reference dimensions stopped: {ex.Message}");
            }

            foreach (var message in failures.Messages.Take(3)) warnings.Add(message);
            return created;
        }

        /// <summary>
        /// Locks form faces onto the reference planes they sit on. NewAlignment returns a
        /// locked dimension, so moving a labelled plane drags the face with it and the solids
        /// rebuild when a parameter changes, instead of sitting frozen.
        /// </summary>
        private static int LockGeometry(
            Document document,
            PlaneSkeleton skeleton,
            IList<Element> forms,
            List<string> warnings)
        {
            if (forms == null || forms.Count == 0) return 0;
            if (skeleton.Plan == null && skeleton.Elevation == null) return 0;

            var options = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            var failures = new FailureCollector();
            var locked = 0;

            using (var transaction = SilentTransaction(document, "Family Agent — lock geometry", failures))
            {
                transaction.Start();

                foreach (var form in forms)
                {
                    // Voids are cutters: constraining them makes Revit fail to rebuild the
                    // cut ("Can't make Extrusion") as soon as a driving parameter moves.
                    var solidForm = form as Extrusion;
                    if (solidForm == null || !solidForm.IsSolid) continue;

                    GeometryElement geometry;
                    try
                    {
                        geometry = form.get_Geometry(options);
                    }
                    catch
                    {
                        continue;
                    }

                    if (geometry == null) continue;

                    foreach (var geometryObject in geometry)
                    {
                        var solid = geometryObject as Solid;
                        if (solid == null) continue;

                        foreach (Face face in solid.Faces)
                        {
                            var planar = face as PlanarFace;
                            if (planar == null || face.Reference == null) continue;

                            var normal = planar.FaceNormal;
                            PlaneAxis axis;
                            double coordinate;

                            if (Math.Abs(normal.X) > 0.999)
                            {
                                axis = PlaneAxis.X;
                                coordinate = planar.Origin.X;
                            }
                            else if (Math.Abs(normal.Y) > 0.999)
                            {
                                axis = PlaneAxis.Y;
                                coordinate = planar.Origin.Y;
                            }
                            else if (Math.Abs(normal.Z) > 0.999)
                            {
                                axis = PlaneAxis.Z;
                                coordinate = planar.Origin.Z;
                            }
                            else
                            {
                                continue;
                            }

                            if (!skeleton.Drives(axis, coordinate)) continue;

                            var plane = skeleton.Find(axis, coordinate);
                            var view = axis == PlaneAxis.Z ? skeleton.Elevation : skeleton.Plan;
                            if (plane == null || view == null) continue;

                            try
                            {
                                document.FamilyCreate.NewAlignment(view, plane.GetReference(), face.Reference);
                                locked += 1;
                            }
                            catch (Exception ex)
                            {
                                // One stubborn face must not cost the whole family its constraints.
                                if (failures.Messages.Count < 3) warnings.Add($"Lock \"{form.Name}\": {ex.Message}");
                            }
                        }
                    }
                }

                var status = transaction.Commit();
                if (status != TransactionStatus.Committed)
                {
                    warnings.Add(
                        $"Geometry locks were rolled back ({status}): {string.Join(" ", failures.Messages.Take(3))}");
                    return 0;
                }
            }

            return locked;
        }

        private sealed class PlaneDimension
        {
            private readonly View _view;
            private readonly ReferencePlane _from;
            private readonly ReferencePlane _to;
            private readonly XYZ _start;
            private readonly XYZ _end;
            private readonly Autodesk.Revit.DB.FamilyParameter _label;

            public PlaneDimension(
                View view,
                ReferencePlane from,
                ReferencePlane to,
                XYZ start,
                XYZ end,
                Autodesk.Revit.DB.FamilyParameter label)
            {
                _view = view;
                _from = from;
                _to = to;
                _start = start;
                _end = end;
                _label = label;
            }

            public string Name => $"{_from.Name} → {_to.Name}";

            public bool Create(Document document, List<string> warnings)
            {
                return AddDimension(document, _view, _from, _to, _start, _end, _label, warnings);
            }
        }

        private static PlaneAxis AxisFor(string name)
        {
            var text = (name ?? string.Empty).ToLowerInvariant();

            if (text.Contains("width") || text.Contains("left") || text.Contains("right")) return PlaneAxis.X;
            if (text.Contains("depth") || text.Contains("front") || text.Contains("back")) return PlaneAxis.Y;
            return PlaneAxis.Z;
        }

        private static View FindView(Document document, ViewType type)
        {
            return new FilteredElementCollector(document)
                .OfClass(typeof(View))
                .Cast<View>()
                .FirstOrDefault(view => !view.IsTemplate && view.ViewType == type);
        }

        private static ReferencePlane FindPlane(Document document, string name)
        {
            return new FilteredElementCollector(document)
                .OfClass(typeof(ReferencePlane))
                .Cast<ReferencePlane>()
                .FirstOrDefault(plane => string.Equals(plane.Name, name, StringComparison.OrdinalIgnoreCase));
        }

        private static ReferencePlane AddPlane(
            Document document,
            View view,
            string name,
            PlaneAxis axis,
            double offset,
            double halfLength)
        {
            XYZ origin;
            XYZ along;
            XYZ across;

            switch (axis)
            {
                case PlaneAxis.X:
                    origin = new XYZ(offset, 0, 0);
                    along = XYZ.BasisY;
                    across = XYZ.BasisZ;
                    break;
                case PlaneAxis.Y:
                    origin = new XYZ(0, offset, 0);
                    along = XYZ.BasisX;
                    across = XYZ.BasisZ;
                    break;
                default:
                    origin = new XYZ(0, 0, offset);
                    along = XYZ.BasisX;
                    across = XYZ.BasisY;
                    break;
            }

            // NewReferencePlane takes absolute points, not directions: the plane runs through
            // the bubble/free ends and a third point offset inside the same plane. Passing a
            // unit vector as the cut direction skewed the plane and made every dimension on
            // it unsatisfiable.
            var bubbleEnd = origin - along * halfLength;
            var freeEnd = origin + along * halfLength;
            var thirdPoint = freeEnd + across * halfLength;

            var plane = document.FamilyCreate.NewReferencePlane2(bubbleEnd, freeEnd, thirdPoint, view);
            if (plane == null) return null;

            try { plane.Name = name; }
            catch { /* keep the generated name */ }

            return plane;
        }

        private static bool AddDimension(
            Document document,
            View view,
            ReferencePlane from,
            ReferencePlane to,
            XYZ start,
            XYZ end,
            Autodesk.Revit.DB.FamilyParameter label,
            List<string> warnings)
        {
            if (view == null) return false;

            try
            {
                if (start.DistanceTo(end) < 1.0 / 304.8) return false;

                var references = new ReferenceArray();
                references.Append(from.GetReference());
                references.Append(to.GetReference());

                var dimension = document.FamilyCreate.NewDimension(view, Line.CreateBound(start, end), references);
                if (dimension == null) return false;

                if (label != null) dimension.FamilyLabel = label;
                return true;
            }
            catch (Exception ex)
            {
                warnings.Add($"Dimension \"{from.Name}\" → \"{to.Name}\": {ex.Message}");
                return false;
            }
        }

        private static HashSet<ElementId> LabelledParameters(Document document)
        {
            var labelled = new HashSet<ElementId>();

            foreach (var dimension in new FilteredElementCollector(document)
                         .OfClass(typeof(Dimension))
                         .Cast<Dimension>())
            {
                try
                {
                    var label = dimension.FamilyLabel;
                    if (label != null) labelled.Add(label.Id);
                }
                catch
                {
                    // Some template dimensions (radial, angular, multi-segment) cannot carry a
                    // label and throw when asked for one.
                }
            }

            return labelled;
        }

        // -------------------------------------------------------------- geometry

        private static List<Element> CreateGeometry(
            Document document,
            ResolvedModel model,
            IDictionary<string, MaterialDef> materials,
            List<string> warnings)
        {
            var forms = new List<Element>();

            foreach (var part in model.Parts)
            {
                try
                {
                    for (var index = 0; index < Math.Max(1, part.ArrayCount); index += 1)
                    {
                        var offset = ArrayOffsetMm(part, index);
                        var body = CreateForm(document, part.Solid, offset, true);

                        if (body == null)
                        {
                            warnings.Add($"Part \"{part.Id}\" produced no solid");
                            continue;
                        }

                        try
                        {
                            body.Name = part.ArrayCount > 1 ? $"{part.Name} {index + 1}" : part.Name;
                        }
                        catch
                        {
                            // Forms do not always accept a name.
                        }

                        AssignMaterial(
                            document,
                            body,
                            MaterialName(part, materials),
                            MaterialColor(part, materials),
                            warnings);
                        forms.Add(body);

                        if (part.Solid.Kind == "cylinder" && part.Solid.InnerRadius > 0)
                        {
                            try
                            {
                                var bore = CreateCylinderForm(
                                    document, part.Solid, offset, part.Solid.InnerRadius, false, true);
                                if (bore != null) forms.Add(bore);
                            }
                            catch (Exception ex)
                            {
                                warnings.Add($"Bore on \"{part.Id}\" failed: {ex.Message}");
                            }
                        }

                        foreach (var cut in part.Cuts)
                        {
                            try
                            {
                                var cutter = CreateForm(document, cut, offset, false);
                                if (cutter != null) forms.Add(cutter);
                            }
                            catch (Exception ex)
                            {
                                warnings.Add($"Cut on \"{part.Id}\" failed: {ex.Message}");
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add($"Part \"{part.Id}\" failed: {ex.Message}");
                }
            }

            return forms;
        }

        private static Vec3d ArrayOffsetMm(ResolvedPart part, int index)
        {
            var distance = part.ArraySpacing * index;
            switch (part.ArrayAxis)
            {
                case "y": return new Vec3d(0, distance, 0);
                case "z": return new Vec3d(0, 0, distance);
                default: return new Vec3d(distance, 0, 0);
            }
        }

        private static Extrusion CreateForm(Document document, ResolvedSolid solid, Vec3d offset, bool isSolid)
        {
            switch (solid.Kind)
            {
                case "box": return CreateBoxForm(document, solid, offset, isSolid);
                case "cylinder": return CreateCylinderForm(document, solid, offset, solid.Radius, isSolid, false);
                case "prism": return CreatePrismForm(document, solid, offset, isSolid);
                default: return null;
            }
        }

        /// <summary>
        /// Native family forms are the requirement: extrusions (and void extrusions for cuts)
        /// stay editable in Revit and can be constrained to reference planes, unlike the free
        /// form elements the builder used before.
        /// </summary>
        private static Extrusion Extrude(
            Document document,
            Plane plane,
            IList<XYZ> points,
            double length,
            bool isSolid)
        {
            if (!(Math.Abs(length) > 1e-9)) throw new InvalidOperationException("extrusion has a zero depth");

            var sketchPlane = SketchPlane.Create(document, plane);

            var curveArray = new CurveArray();
            foreach (var curve in Loop(points)) curveArray.Append(curve);

            var profile = new CurveArrArray();
            profile.Append(curveArray);

            return document.FamilyCreate.NewExtrusion(isSolid, profile, sketchPlane, length);
        }

        private static Plane PlaneAt(XYZ origin, XYZ normal)
        {
            var w = normal.Normalize();
            var helper = Math.Abs(w.Z) < 0.9 ? XYZ.BasisZ : XYZ.BasisX;
            var u = w.CrossProduct(helper).Normalize();
            var v = w.CrossProduct(u).Normalize();
            return Plane.CreateByOriginAndBasis(origin, u, v);
        }

        private static XYZ AxisUnit(string axis)
        {
            switch (axis)
            {
                case "x": return XYZ.BasisX;
                case "y": return XYZ.BasisY;
                default: return XYZ.BasisZ;
            }
        }

        private static Extrusion CreateBoxForm(Document document, ResolvedSolid solid, Vec3d offset, bool isSolid)
        {
            var width = Ft(Math.Abs(solid.Size.X));
            var depth = Ft(Math.Abs(solid.Size.Y));
            var height = Ft(Math.Abs(solid.Size.Z));

            if (width <= 0 || depth <= 0 || height <= 0)
                throw new InvalidOperationException("box has a zero dimension");

            var angle = solid.RotationZ * DegToRad;
            var u = new XYZ(Math.Cos(angle), Math.Sin(angle), 0);
            var v = new XYZ(-Math.Sin(angle), Math.Cos(angle), 0);

            var zBase = Math.Min(solid.Origin.Z, solid.Origin.Z + solid.Size.Z) + offset.Z;
            var center = new XYZ(
                Ft(solid.Origin.X + offset.X),
                Ft(solid.Origin.Y + offset.Y),
                Ft(zBase));

            var halfWidth = width / 2;
            var halfDepth = depth / 2;

            var points = new List<XYZ>
            {
                center - u * halfWidth - v * halfDepth,
                center + u * halfWidth - v * halfDepth,
                center + u * halfWidth + v * halfDepth,
                center - u * halfWidth + v * halfDepth,
            };

            return Extrude(document, Plane.CreateByOriginAndBasis(center, u, v), points, height, isSolid);
        }

        private static Extrusion CreateCylinderForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            double radiusMm,
            bool isSolid,
            bool asBore)
        {
            var radius = Ft(radiusMm);
            var length = Ft(Math.Abs(solid.Height));

            if (radius <= 0 || length <= 0) throw new InvalidOperationException("cylinder has a zero dimension");

            var direction = AxisUnit(solid.Axis) * (solid.Height >= 0 ? 1 : -1);
            var basePoint = new XYZ(
                Ft(solid.Base.X + offset.X),
                Ft(solid.Base.Y + offset.Y),
                Ft(solid.Base.Z + offset.Z));

            // A bore has to overshoot both ends to cut the tube cleanly.
            var start = asBore ? basePoint - direction * Ft(0.6) : basePoint;
            var end = asBore ? length + Ft(1.2) : length;

            var plane = PlaneAt(start, direction);
            var segments = Math.Max(12, solid.Segments);
            var points = new List<XYZ>(segments);

            for (var i = 0; i < segments; i += 1)
            {
                var angle = 2 * Math.PI * i / segments;
                points.Add(start + plane.XVec * (Math.Cos(angle) * radius) + plane.YVec * (Math.Sin(angle) * radius));
            }

            return Extrude(document, plane, points, end, isSolid);
        }

        private static Extrusion CreatePrismForm(Document document, ResolvedSolid solid, Vec3d offset, bool isSolid)
        {
            var length = Ft(Math.Abs(solid.To - solid.From));
            if (length <= 0) throw new InvalidOperationException("prism has a zero depth");

            XYZ u, v, axisUnit;
            XYZ origin;
            var baseCoordinate = Math.Min(solid.From, solid.To);

            switch (solid.Plane)
            {
                case "xz":
                    u = XYZ.BasisX;
                    v = XYZ.BasisZ;
                    axisUnit = XYZ.BasisY;
                    origin = new XYZ(0, Ft(baseCoordinate + offset.Y), 0);
                    break;
                case "yz":
                    u = XYZ.BasisY;
                    v = XYZ.BasisZ;
                    axisUnit = XYZ.BasisX;
                    origin = new XYZ(Ft(baseCoordinate + offset.X), 0, 0);
                    break;
                default:
                    u = XYZ.BasisX;
                    v = XYZ.BasisY;
                    axisUnit = XYZ.BasisZ;
                    origin = new XYZ(0, 0, Ft(baseCoordinate + offset.Z));
                    break;
            }

            var points = new List<XYZ>();
            foreach (var point in solid.Points)
            {
                var a = Ft(point.A);
                var b = Ft(point.B);

                switch (solid.Plane)
                {
                    case "xz":
                        points.Add(origin + u * (a + Ft(offset.X)) + v * (b + Ft(offset.Z)));
                        break;
                    case "yz":
                        points.Add(origin + u * (a + Ft(offset.Y)) + v * (b + Ft(offset.Z)));
                        break;
                    default:
                        points.Add(origin + u * (a + Ft(offset.X)) + v * (b + Ft(offset.Y)));
                        break;
                }
            }

            if (points.Count < 3) throw new InvalidOperationException("prism needs at least 3 points");

            var normal = u.CrossProduct(v);
            var desired = axisUnit * Math.Sign(solid.To - solid.From);
            var end = desired.DotProduct(normal) > 0 ? length : -length;

            return Extrude(document, Plane.CreateByOriginAndBasis(origin, u, v), points, end, isSolid);
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

        private static IDictionary<string, MaterialDef> MaterialLookup(FamilySpec spec)
        {
            var lookup = new Dictionary<string, MaterialDef>(StringComparer.OrdinalIgnoreCase);
            foreach (var material in spec.Materials ?? new List<MaterialDef>())
            {
                if (string.IsNullOrWhiteSpace(material?.Name)) continue;
                if (!lookup.ContainsKey(material.Name)) lookup.Add(material.Name, material);
            }
            return lookup;
        }

        private static string MaterialName(ResolvedPart part, IDictionary<string, MaterialDef> materials)
        {
            if (!string.IsNullOrWhiteSpace(part.Material)) return part.Material;
            if (!string.IsNullOrWhiteSpace(part.Color)) return part.Name;
            return null;
        }

        private static string MaterialColor(ResolvedPart part, IDictionary<string, MaterialDef> materials)
        {
            if (!string.IsNullOrWhiteSpace(part.Color)) return part.Color;

            if (!string.IsNullOrWhiteSpace(part.Material) &&
                materials.TryGetValue(part.Material, out var material))
            {
                return material.Color;
            }

            return null;
        }

        private static void AssignMaterial(
            Document document,
            Element element,
            string name,
            string color,
            List<string> warnings)
        {
            if (string.IsNullOrWhiteSpace(name)) return;

            try
            {
                var material = FindOrCreateMaterial(document, name, color, warnings);
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

        private static Material FindOrCreateMaterial(
            Document document,
            string name,
            string color,
            List<string> warnings)
        {
            var existing = new FilteredElementCollector(document)
                .OfClass(typeof(Material))
                .Cast<Material>()
                .FirstOrDefault(material => string.Equals(material.Name, name, StringComparison.OrdinalIgnoreCase));

            var material = existing;

            if (material == null)
            {
                try
                {
                    var id = Material.Create(document, name);
                    material = document.GetElement(id) as Material;
                }
                catch (Exception ex)
                {
                    warnings.Add($"Material \"{name}\" could not be created: {ex.Message}");
                    return null;
                }
            }

            if (material != null) ApplyColor(material, color, warnings);
            return material;
        }

        private static void ApplyColor(Material material, string hex, List<string> warnings)
        {
            if (string.IsNullOrWhiteSpace(hex)) return;

            var value = hex.Trim().TrimStart('#');
            if (value.Length == 3)
            {
                value = new string(new[]
                {
                    value[0], value[0], value[1], value[1], value[2], value[2],
                });
            }

            if (value.Length != 6 ||
                !int.TryParse(value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb))
            {
                warnings.Add($"Material \"{material.Name}\" color \"{hex}\" is not a hex value");
                return;
            }

            try
            {
                material.Color = new Color(
                    (byte)((rgb >> 16) & 0xFF),
                    (byte)((rgb >> 8) & 0xFF),
                    (byte)(rgb & 0xFF));
            }
            catch (Exception ex)
            {
                warnings.Add($"Material \"{material.Name}\" color: {ex.Message}");
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
