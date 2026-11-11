// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get title => 'Checkout';

  @override
  String helloName(String name) {
    return 'Hello $name';
  }

  @override
  String items(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count items',
      one: 'One item',
      zero: 'No items',
    );
    return '$_temp0';
  }

  @override
  String total(double amount) {
    final intl.NumberFormat amountNumberFormat = intl.NumberFormat.currency(
      locale: localeName,
      symbol: '€',
    );
    final String amountString = amountNumberFormat.format(amount);

    return 'Total: $amountString';
  }

  @override
  String get payNow => 'Pay now';
}
