using System;
using System.Collections.Generic;
using System.IO;
using FamilyAgent.Core;

namespace FamilyAgent.SelfTest
{
    internal static class Program
    {
        private static int _failures;

        private static void Check(string name, Action test)
        {
            try
            {
                test();
                Console.WriteLine($"PASS  {name}");
            }
            catch (Exception ex)
            {
                _failures += 1;
                Console.WriteLine($"FAIL  {name}");
                Console.WriteLine($"      {ex.Message}");
            }
        }

        private static void Expect(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }

        private static void ExpectClose(double actual, double expected, double tolerance, string message)
        {
            if (Math.Abs(actual - expected) > tolerance)
                throw new Exception($"{message}: expected {expected}, got {actual}");
        }

        private static string FindExample()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                var candidate = Path.Combine(directory.FullName, "spec", "examples", "fcu-080.json");
                if (File.Exists(candidate)) return candidate;
                directory = directory.Parent;
            }
            throw new FileNotFoundException("Could not find spec/examples/fcu-080.json");
        }

        private static int Main(string[] args)
        {
            var lookup = new Func<string, double>(name =>
            {
                switch (name.ToLowerInvariant())
                {
                    case "casing length": return 1910;
                    case "flange width": return 30;
                    default: throw new ExpressionException($"Unknown parameter \"{name}\"");
                }
            });

            Check("arithmetic precedence", () =>
            {
                ExpectClose(Expression.Evaluate("1 + 2 * 3", lookup), 7, 1e-9, "1 + 2 * 3");
                ExpectClose(Expression.Evaluate("2 ^ 3 ^ 2", lookup), 512, 1e-9, "2 ^ 3 ^ 2");
            });

            Check("parameter references", () =>
            {
                ExpectClose(Expression.Evaluate("[Casing Length] + 2 * [Flange Width]", lookup), 1970, 1e-6, "overall width");
            });

            Check("unit literals", () =>
            {
                ExpectClose(Expression.Evaluate("1in + 1ft", lookup), 330.2, 1e-6, "inches and feet");
                ExpectClose(Expression.Evaluate("560mm - 140mm", lookup), 420, 1e-9, "mm literals");
            });

            Check("functions use degrees", () =>
            {
                ExpectClose(Expression.Evaluate("sin(30)", lookup), 0.5, 1e-9, "sin 30");
                ExpectClose(Expression.Evaluate("round(2.5)", lookup), 3, 1e-9, "round half away");
                ExpectClose(Expression.Evaluate("pi()", lookup), Math.PI, 1e-9, "pi()");
            });

            Check("division by zero is reported", () =>
            {
                try
                {
                    Expression.Evaluate("1 / 0", lookup);
                    throw new Exception("expected an exception");
                }
                catch (ExpressionException ex)
                {
                    Expect(ex.Message.Contains("zero"), "message should mention zero");
                }
            });

            Check("example spec loads and resolves", () =>
            {
                var json = File.ReadAllText(FindExample());
                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(spec.Name.StartsWith("Trane"), "family name");
                Expect(model.Warnings.Count == 0, $"unexpected warnings: {string.Join("; ", model.Warnings)}");
                Expect(model.Parts.Count == 17, $"expected 17 parts, got {model.Parts.Count}");

                var size = model.Bounds.Size;
                ExpectClose(size.X, 1970, 0.01, "overall width");
                ExpectClose(size.Z, 596, 0.01, "overall height");

                var overallWidth = parameters.ByKey["Overall Width"];
                Expect(overallWidth.Formula != null, "Overall Width keeps its formula");
                ExpectClose(overallWidth.Number ?? -1, 1970, 0.01, "Overall Width value");
            });

            Check("formula errors do not throw", () =>
            {
                var spec = new FamilySpec
                {
                    Name = "Broken",
                    Parts = new List<FamilyPart>
                    {
                        new FamilyPart
                        {
                            Id = "one",
                            Name = "One",
                            Solid = new SolidPrimitive
                            {
                                Kind = "box",
                                Origin = new Vec3(0, 0, 0),
                                Size = new Vec3("nope(", 100, 100),
                            },
                        },
                    },
                    Parameters = new List<FamilyParameter>
                    {
                        new FamilyParameter { Name = "A", Type = "Length", Formula = "[Missing] * 2" },
                    },
                };

                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);
                Expect(parameters.Errors.Count > 0, "parameter error expected");
                Expect(model.Warnings.Count > 0, "geometry warning expected");
                Expect(model.Parts.Count == 0, "broken part should be skipped");
            });

            Console.WriteLine();
            Console.WriteLine(_failures == 0 ? "All core checks passed." : $"{_failures} check(s) failed.");
            return _failures == 0 ? 0 : 1;
        }
    }
}
