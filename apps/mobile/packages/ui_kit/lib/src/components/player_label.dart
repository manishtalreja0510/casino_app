/// A short, non-identifying label for another player.
///
/// Two reasons this is a shared helper rather than a `substring` at each call site.
///
/// The first is correctness: `substring(0, 4)` throws on any id shorter than four
/// characters, which never happens with a UUID and happens immediately with a test
/// fixture — a display detail taking the whole screen down.
///
/// The second is rule 15: a public seat list is not a place to print display names or
/// anything else that links a person across tables. A stable, meaningless prefix is enough
/// to tell two opponents apart, which is all the table needs.
String playerLabel(String userId, {int length = 4}) {
  if (userId.isEmpty) return 'Player';
  final take = userId.length < length ? userId.length : length;
  return 'Player ${userId.substring(0, take)}';
}
