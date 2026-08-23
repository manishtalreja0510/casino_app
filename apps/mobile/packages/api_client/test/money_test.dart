import 'package:api_client/api_client.dart';
import 'package:test/test.dart';

void main() {
  group('Money (rule 4: integer minor units only)', () {
    test('parses integer amounts', () {
      final money = Money.fromJson({'amount': 1234567, 'currency': 'TST'});
      expect(money.amount, 1234567);
      expect(money.currency, 'TST');
    });

    test('REJECTS a floating-point amount rather than rounding it', () {
      // A double on the wire means precision was already lost upstream. Silently
      // accepting it would render wrong money to a player.
      expect(() => Money.fromJson({'amount': 12.5, 'currency': 'TST'}), throwsFormatException);
    });

    test('rejects a missing or empty currency', () {
      expect(() => Money.fromJson({'amount': 100}), throwsFormatException);
      expect(() => Money.fromJson({'amount': 100, 'currency': ''}), throwsFormatException);
    });

    test('formats minor units for display', () {
      expect(const Money(amount: 1234567, currency: 'TST').format(), '12,345.67 TST');
      expect(const Money(amount: 0, currency: 'TST').format(), '0.00 TST');
      expect(const Money(amount: 5, currency: 'TST').format(), '0.05 TST');
      expect(const Money(amount: 100, currency: 'TST').format(showCurrency: false), '1.00');
    });

    test('formats negative amounts with the sign outside the grouping', () {
      expect(const Money(amount: -250050, currency: 'TST').format(), '-2,500.50 TST');
    });

    test('groups large amounts', () {
      expect(const Money(amount: 123456789012, currency: 'TST').format(), '1,234,567,890.12 TST');
    });

    test('round-trips through JSON without changing the integer', () {
      const original = Money(amount: 999999, currency: 'TST');
      expect(Money.fromJson(original.toJson()), original);
    });

    test('supports zero-decimal display for currencies that need it', () {
      expect(const Money(amount: 1500, currency: 'TST').format(decimalPlaces: 0), '1,500 TST');
    });
  });
}
