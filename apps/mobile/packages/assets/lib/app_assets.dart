/// Generated asset registry.
///
/// **No raw asset path string appears anywhere else in the app** — every reference goes
/// through these constants (`asset-animation-pipeline.md`). Two reasons:
///  1. A typo becomes a compile error instead of a runtime blank square.
///  2. P19 drops in the designed files under the SAME names, so nothing calling an asset
///     changes. The names are final now; only the bytes change later.
///
/// Naming: `assets/{kind}/{domain}/{prefix}_{name}[_{variant}].{ext}`
/// with prefixes `img_`, `ic_`, `anim_`, `sfx_`.
library;

class AppImages {
  const AppImages._();

  static const String tableFelt = 'assets/images/game/img_table_felt.png';
  static const String cardBack = 'assets/images/game/img_card_back.png';
  static const String avatarPlaceholder = 'assets/images/common/img_avatar_placeholder.png';
  static const String emptyBox = 'assets/images/common/img_empty_box.png';
  static const String logo = 'assets/images/brand/img_logo.png';

  static const List<String> all = [tableFelt, cardBack, avatarPlaceholder, emptyBox, logo];
}

class AppIcons {
  const AppIcons._();

  static const String chip = 'assets/icons/game/ic_chip.png';
  static const String chip100 = 'assets/icons/game/ic_chip_100.png';
  static const String dealerButton = 'assets/icons/game/ic_dealer_button.png';
  static const String wallet = 'assets/icons/common/ic_wallet.png';
  static const String offline = 'assets/icons/common/ic_offline.png';

  static const List<String> all = [chip, chip100, dealerButton, wallet, offline];
}

/// Animation sources. Placeholder implementations are built-in Flutter animations, so
/// these files are empty placeholders until P19 supplies Rive/Lottie for the same names.
class AppAnimations {
  const AppAnimations._();

  static const String cardDeal = 'assets/animations/game/anim_card_deal.json';
  static const String chipMove = 'assets/animations/game/anim_chip_move.json';
  static const String winCelebration = 'assets/animations/game/anim_win_celebration.json';
  static const String loading = 'assets/animations/common/anim_loading.json';

  static const List<String> all = [cardDeal, chipMove, winCelebration, loading];
}

class AppAudio {
  const AppAudio._();

  static const String chipStack = 'assets/audio/game/sfx_chip_stack.wav';
  static const String cardFlip = 'assets/audio/game/sfx_card_flip.wav';
  static const String win = 'assets/audio/game/sfx_win.wav';
  static const String tap = 'assets/audio/common/sfx_tap.wav';

  static const List<String> all = [chipStack, cardFlip, win, tap];
}

/// Every registered asset — used by the test that proves each declared file exists,
/// so a missing asset fails the build rather than appearing as a blank square in a game.
const List<String> allRegisteredAssets = [
  ...AppImages.all,
  ...AppIcons.all,
  ...AppAnimations.all,
  ...AppAudio.all,
];
