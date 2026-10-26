using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace FamilyAgent.Core
{
    public sealed class ExpressionException : Exception
    {
        public ExpressionException(string message) : base(message) { }
    }

    /// <summary>
    /// Expression language shared with the studio. Units are millimetres, trigonometry is in
    /// degrees and the function set matches what Revit family formulas accept.
    /// </summary>
    public static class Expression
    {
        private const double Degrees = Math.PI / 180.0;

        private static readonly ConcurrentDictionary<string, Node> Cache =
            new ConcurrentDictionary<string, Node>(StringComparer.Ordinal);

        private static readonly Dictionary<string, double> UnitFactors =
            new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
            {
                { "mm", 1 },
                { "cm", 10 },
                { "m", 1000 },
                { "in", 25.4 },
                { "ft", 304.8 },
                { "deg", 1 },
                { "°", 1 },
            };

        public static double Evaluate(string source, Func<string, double> lookup)
        {
            if (string.IsNullOrWhiteSpace(source)) throw new ExpressionException("Empty expression");
            return Eval(Compile(source), lookup);
        }

        public static List<string> Dependencies(string source)
        {
            var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            Collect(Compile(source), set);
            return new List<string>(set);
        }

        private static Node Compile(string source)
        {
            var key = source.Trim();
            if (Cache.TryGetValue(key, out var cached)) return cached;
            var node = new Parser(Tokenize(key), key).Parse();
            if (Cache.Count > 500) Cache.Clear();
            Cache[key] = node;
            return node;
        }

        private static void Collect(Node node, ISet<string> into)
        {
            switch (node)
            {
                case RefNode r:
                    if (!string.Equals(r.Name, "pi", StringComparison.OrdinalIgnoreCase)) into.Add(r.Name);
                    break;
                case NegateNode n:
                    Collect(n.Operand, into);
                    break;
                case BinaryNode b:
                    Collect(b.Left, into);
                    Collect(b.Right, into);
                    break;
                case CallNode c:
                    foreach (var arg in c.Arguments) Collect(arg, into);
                    break;
            }
        }

        private static double Eval(Node node, Func<string, double> lookup)
        {
            switch (node)
            {
                case NumberNode n:
                    return n.Value;

                case RefNode r:
                    if (string.Equals(r.Name, "pi", StringComparison.OrdinalIgnoreCase)) return Math.PI;
                    return lookup(r.Name);

                case NegateNode n:
                    return -Eval(n.Operand, lookup);

                case BinaryNode b:
                {
                    var left = Eval(b.Left, lookup);
                    var right = Eval(b.Right, lookup);
                    switch (b.Operator)
                    {
                        case "+": return left + right;
                        case "-": return left - right;
                        case "*": return left * right;
                        case "/":
                            if (Math.Abs(right) < double.Epsilon) throw new ExpressionException("Division by zero");
                            return left / right;
                        case "%":
                            if (Math.Abs(right) < double.Epsilon) throw new ExpressionException("Division by zero");
                            return left % right;
                        case "^": return Math.Pow(left, right);
                        default: throw new ExpressionException($"Unknown operator \"{b.Operator}\"");
                    }
                }

                case CallNode c:
                {
                    var args = new double[c.Arguments.Count];
                    for (var i = 0; i < args.Length; i += 1) args[i] = Eval(c.Arguments[i], lookup);
                    return Call(c.Name, args);
                }
            }

            throw new ExpressionException("Unsupported expression");
        }

        private static double Call(string name, double[] args)
        {
            void Expect(int count)
            {
                if (args.Length != count)
                    throw new ExpressionException($"Function \"{name}\" expects {count} argument(s), got {args.Length}");
            }

            switch (name)
            {
                case "abs": Expect(1); return Math.Abs(args[0]);
                case "sqrt":
                    Expect(1);
                    if (args[0] < 0) throw new ExpressionException("sqrt() of a negative number");
                    return Math.Sqrt(args[0]);
                case "round":
                    if (args.Length < 1 || args.Length > 2) throw new ExpressionException("round() expects 1 or 2 arguments");
                    return RoundHalfAway(args[0], args.Length > 1 ? (int)args[1] : 0);
                case "roundup":
                    if (args.Length < 1 || args.Length > 2) throw new ExpressionException("roundup() expects 1 or 2 arguments");
                    return RoundDirection(args[0], args.Length > 1 ? (int)args[1] : 0, true);
                case "rounddown":
                    if (args.Length < 1 || args.Length > 2) throw new ExpressionException("rounddown() expects 1 or 2 arguments");
                    return RoundDirection(args[0], args.Length > 1 ? (int)args[1] : 0, false);
                case "min":
                    if (args.Length == 0) throw new ExpressionException("min() expects at least 1 argument");
                    var min = args[0];
                    for (var i = 1; i < args.Length; i += 1) min = Math.Min(min, args[i]);
                    return min;
                case "max":
                    if (args.Length == 0) throw new ExpressionException("max() expects at least 1 argument");
                    var max = args[0];
                    for (var i = 1; i < args.Length; i += 1) max = Math.Max(max, args[i]);
                    return max;
                case "pow": Expect(2); return Math.Pow(args[0], args[1]);
                case "exp": Expect(1); return Math.Exp(args[0]);
                case "ln":
                    Expect(1);
                    if (args[0] <= 0) throw new ExpressionException("ln() needs a positive number");
                    return Math.Log(args[0]);
                case "log":
                    Expect(1);
                    if (args[0] <= 0) throw new ExpressionException("log() needs a positive number");
                    return Math.Log10(args[0]);
                case "sin": Expect(1); return Math.Sin(args[0] * Degrees);
                case "cos": Expect(1); return Math.Cos(args[0] * Degrees);
                case "tan": Expect(1); return Math.Tan(args[0] * Degrees);
                case "asin": Expect(1); return Math.Asin(args[0]) / Degrees;
                case "acos": Expect(1); return Math.Acos(args[0]) / Degrees;
                case "atan": Expect(1); return Math.Atan(args[0]) / Degrees;
                case "pi": Expect(0); return Math.PI;
                default: throw new ExpressionException($"Unknown function \"{name}\"");
            }
        }

        private static double RoundHalfAway(double value, int digits)
        {
            var factor = Math.Pow(10, digits);
            var scaled = value * factor;
            var rounded = Math.Sign(scaled) * Math.Round(Math.Abs(scaled), MidpointRounding.AwayFromZero);
            return rounded / factor;
        }

        private static double RoundDirection(double value, int digits, bool up)
        {
            var factor = Math.Pow(10, digits);
            var scaled = value * factor;
            return (up ? Math.Ceiling(scaled) : Math.Floor(scaled)) / factor;
        }

        // ---------------------------------------------------------------- lexer

        private enum TokenKind
        {
            Number,
            Name,
            Operator,
        }

        private struct Token
        {
            public TokenKind Kind;
            public double Number;
            public string Text;
            public int Position;
        }

        private static List<Token> Tokenize(string source)
        {
            var tokens = new List<Token>();
            var i = 0;

            var trimmed = source.TrimStart();
            if (trimmed.StartsWith("=", StringComparison.Ordinal)) i = source.IndexOf('=') + 1;

            while (i < source.Length)
            {
                var ch = source[i];

                if (char.IsWhiteSpace(ch))
                {
                    i += 1;
                    continue;
                }

                if (ch == '[')
                {
                    var end = source.IndexOf(']', i + 1);
                    if (end < 0) throw new ExpressionException($"Unclosed \"[\" in \"{source}\"");
                    var name = source.Substring(i + 1, end - i - 1).Trim();
                    if (name.Length == 0) throw new ExpressionException($"Empty parameter reference in \"{source}\"");
                    tokens.Add(new Token { Kind = TokenKind.Name, Text = name, Position = i });
                    i = end + 1;
                    continue;
                }

                if (ch == '(' || ch == ')' || ch == ',')
                {
                    tokens.Add(new Token { Kind = TokenKind.Operator, Text = ch.ToString(), Position = i });
                    i += 1;
                    continue;
                }

                if ("+-*/^%".IndexOf(ch) >= 0)
                {
                    tokens.Add(new Token { Kind = TokenKind.Operator, Text = ch.ToString(), Position = i });
                    i += 1;
                    continue;
                }

                if (char.IsDigit(ch) || ch == '.')
                {
                    var start = i;
                    var seenDot = false;
                    while (i < source.Length && (char.IsDigit(source[i]) || source[i] == '.'))
                    {
                        if (source[i] == '.')
                        {
                            if (seenDot) throw new ExpressionException($"Invalid number in \"{source}\"");
                            seenDot = true;
                        }
                        i += 1;
                    }

                    if (i < source.Length && (source[i] == 'e' || source[i] == 'E'))
                    {
                        var mark = i;
                        i += 1;
                        if (i < source.Length && (source[i] == '+' || source[i] == '-')) i += 1;
                        if (i < source.Length && char.IsDigit(source[i]))
                        {
                            while (i < source.Length && char.IsDigit(source[i])) i += 1;
                        }
                        else
                        {
                            i = mark;
                        }
                    }

                    var raw = source.Substring(start, i - start);
                    if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                        throw new ExpressionException($"Invalid number \"{raw}\" in \"{source}\"");

                    if (i < source.Length && (char.IsLetter(source[i]) || source[i] == '°'))
                    {
                        var unitStart = i;
                        while (i < source.Length && (char.IsLetter(source[i]) || source[i] == '°')) i += 1;
                        var suffix = source.Substring(unitStart, i - unitStart);
                        if (!UnitFactors.TryGetValue(suffix, out var factor))
                            throw new ExpressionException($"Unknown unit \"{suffix}\" in \"{source}\"");
                        value *= factor;
                    }

                    tokens.Add(new Token { Kind = TokenKind.Number, Number = value, Position = start });
                    continue;
                }

                if (char.IsLetter(ch) || ch == '_')
                {
                    var start = i;
                    while (i < source.Length && (char.IsLetterOrDigit(source[i]) || source[i] == '_')) i += 1;
                    tokens.Add(new Token { Kind = TokenKind.Name, Text = source.Substring(start, i - start), Position = start });
                    continue;
                }

                throw new ExpressionException($"Unexpected character \"{ch}\" in \"{source}\"");
            }

            if (tokens.Count == 0) throw new ExpressionException("Empty expression");
            return tokens;
        }

        // --------------------------------------------------------------- parser

        private abstract class Node
        {
        }

        private sealed class NumberNode : Node
        {
            public double Value;
        }

        private sealed class RefNode : Node
        {
            public string Name;
        }

        private sealed class NegateNode : Node
        {
            public Node Operand;
        }

        private sealed class BinaryNode : Node
        {
            public string Operator;
            public Node Left;
            public Node Right;
        }

        private sealed class CallNode : Node
        {
            public string Name;
            public List<Node> Arguments = new List<Node>();
        }

        private sealed class Parser
        {
            private readonly List<Token> _tokens;
            private readonly string _source;
            private int _index;

            public Parser(List<Token> tokens, string source)
            {
                _tokens = tokens;
                _source = source;
            }

            public Node Parse()
            {
                var node = ParseSum();
                if (_index < _tokens.Count)
                    throw new ExpressionException($"Unexpected \"{TokenText(_tokens[_index])}\" in \"{_source}\"");
                return node;
            }

            private static string TokenText(Token token) =>
                token.Kind == TokenKind.Number
                    ? token.Number.ToString(CultureInfo.InvariantCulture)
                    : token.Text ?? string.Empty;

            private Token? Peek() => _index < _tokens.Count ? _tokens[_index] : (Token?)null;

            private string TakeOperator(params string[] options)
            {
                var token = Peek();
                if (token == null || token.Value.Kind != TokenKind.Operator) return null;
                foreach (var option in options)
                {
                    if (token.Value.Text == option)
                    {
                        _index += 1;
                        return option;
                    }
                }
                return null;
            }

            private Node ParseSum()
            {
                var left = ParseProduct();
                while (true)
                {
                    var op = TakeOperator("+", "-");
                    if (op == null) return left;
                    left = new BinaryNode { Operator = op, Left = left, Right = ParseProduct() };
                }
            }

            private Node ParseProduct()
            {
                var left = ParseUnary();
                while (true)
                {
                    var op = TakeOperator("*", "/", "%");
                    if (op == null) return left;
                    left = new BinaryNode { Operator = op, Left = left, Right = ParseUnary() };
                }
            }

            private Node ParseUnary()
            {
                if (TakeOperator("-") != null) return new NegateNode { Operand = ParseUnary() };
                if (TakeOperator("+") != null) return ParseUnary();
                return ParsePower();
            }

            private Node ParsePower()
            {
                var left = ParsePrimary();
                if (TakeOperator("^") != null)
                    return new BinaryNode { Operator = "^", Left = left, Right = ParseUnary() };
                return left;
            }

            private Node ParsePrimary()
            {
                var token = Peek();
                if (token == null) throw new ExpressionException($"Unexpected end of \"{_source}\"");

                if (token.Value.Kind == TokenKind.Number)
                {
                    _index += 1;
                    return new NumberNode { Value = token.Value.Number };
                }

                if (token.Value.Kind == TokenKind.Name)
                {
                    _index += 1;
                    var next = Peek();
                    if (next != null && next.Value.Kind == TokenKind.Operator && next.Value.Text == "(")
                    {
                        _index += 1;
                        var call = new CallNode { Name = token.Value.Text.ToLowerInvariant() };
                        if (TakeOperator(")") == null)
                        {
                            while (true)
                            {
                                call.Arguments.Add(ParseSum());
                                if (TakeOperator(",") != null) continue;
                                break;
                            }
                            if (TakeOperator(")") == null)
                                throw new ExpressionException($"Missing \")\" in \"{_source}\"");
                        }
                        return call;
                    }
                    return new RefNode { Name = token.Value.Text };
                }

                if (token.Value.Text == "(")
                {
                    _index += 1;
                    var node = ParseSum();
                    if (TakeOperator(")") == null)
                        throw new ExpressionException($"Missing \")\" in \"{_source}\"");
                    return node;
                }

                throw new ExpressionException($"Unexpected \"{TokenText(token.Value)}\" in \"{_source}\"");
            }
        }
    }
}
