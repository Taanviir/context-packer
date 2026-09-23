using System;

namespace Billing
{
    /** An invoice line. */
    public class Line
    {
        public decimal Amount { get; set; }
    }

    public interface ITaxRule
    {
        decimal Apply(decimal amount);
    }

    /** Sums invoice lines. */
    public static class Totals
    {
        public static decimal Sum(Line[] lines) => lines.Sum(l => l.Amount);
        private static decimal Round(decimal x) => Math.Round(x, 2);
    }

    public enum Currency { Usd, Eur }
}
