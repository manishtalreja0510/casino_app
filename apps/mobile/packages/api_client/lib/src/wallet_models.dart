/// Wallet payloads mirroring `/wallet/*` (P4).
library;

import 'money.dart';

class WalletTransaction {
  const WalletTransaction({
    required this.id,
    required this.type,
    required this.amount,
    required this.createdAt,
    this.refType,
    this.refId,
  });

  final String id;

  /// funding | buy_in | settlement | reversal | adjustment.
  final String type;

  /// Signed: negative is money leaving the wallet. Always integer minor units (rule 4).
  final Money amount;

  final DateTime createdAt;
  final String? refType;
  final String? refId;

  bool get isCredit => amount.amount > 0;

  factory WalletTransaction.fromJson(Map<String, dynamic> json) => WalletTransaction(
    id: json['id'] as String,
    type: json['type'] as String,
    amount: Money.fromJson(json['amount'] as Map<String, dynamic>),
    createdAt: DateTime.parse(json['createdAt'] as String),
    refType: json['refType'] as String?,
    refId: json['refId'] as String?,
  );
}
