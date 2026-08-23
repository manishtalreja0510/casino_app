/// Money mirrors `packages/contracts/src/money.ts`.
///
/// **Integer minor units only** (rule 4). The client performs no balance arithmetic —
/// the server is authoritative for every balance (rules 1–2) — so this type exists to
/// carry and format a server-provided amount, not to compute one.
class Money {
  const Money({required this.amount, required this.currency});

  /// Integer minor units (e.g. cents). Never a double.
  final int amount;
  final String currency;

  static const String testCurrency = 'TST';

  factory Money.fromJson(Map<String, dynamic> json) {
    final rawAmount = json['amount'];
    if (rawAmount is! int) {
      // A double here means the server or a proxy has already lost precision, or the
      // contract was broken. Failing loudly beats silently rendering wrong money.
      throw FormatException('money amount must be an integer in minor units, got $rawAmount');
    }
    final currency = json['currency'];
    if (currency is! String || currency.isEmpty) {
      throw const FormatException('money currency is required');
    }
    return Money(amount: rawAmount, currency: currency);
  }

  Map<String, dynamic> toJson() => {'amount': amount, 'currency': currency};

  bool get isZero => amount == 0;
  bool get isNegative => amount < 0;

  /// Formats for display, e.g. 1234567 -> "12,345.67".
  ///
  /// Presentation only: the integer stays the source of truth, and no rounding decision
  /// is ever made on the client.
  String format({int decimalPlaces = 2, bool showCurrency = true}) {
    final divisor = _pow10(decimalPlaces);
    final negative = amount < 0;
    final absolute = amount.abs();
    final whole = absolute ~/ divisor;
    final fraction = absolute % divisor;

    final groupedWhole = _group(whole.toString());
    final buffer = StringBuffer();
    if (negative) buffer.write('-');
    buffer.write(groupedWhole);
    if (decimalPlaces > 0) {
      buffer.write('.');
      buffer.write(fraction.toString().padLeft(decimalPlaces, '0'));
    }
    if (showCurrency) {
      buffer.write(' ');
      buffer.write(currency);
    }
    return buffer.toString();
  }

  static int _pow10(int exponent) {
    var result = 1;
    for (var i = 0; i < exponent; i++) {
      result *= 10;
    }
    return result;
  }

  static String _group(String digits) {
    final buffer = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
      buffer.write(digits[i]);
    }
    return buffer.toString();
  }

  @override
  bool operator ==(Object other) =>
      other is Money && other.amount == amount && other.currency == currency;

  @override
  int get hashCode => Object.hash(amount, currency);

  @override
  String toString() => 'Money($amount $currency)';
}
