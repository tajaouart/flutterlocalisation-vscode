import 'package:flutter/material.dart';

class Home extends StatelessWidget {
  const Home({super.key, required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Text('Welcome back'),
        Text('Hello $name'),
        Text(AppLocalizations.of(context)!.title),
        Text('Brand'), // l10n-ignore
      ],
    );
  }
}
