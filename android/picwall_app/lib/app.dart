import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme.dart';
import 'features/auth/session_controller.dart';
import 'features/auth/login_page.dart';
import 'features/gallery/gallery_page.dart';
import 'features/my/my_page.dart';
import 'features/discover/discover_page.dart';
import 'features/settings/onboarding_page.dart';
import 'features/lock/lock_screen.dart';
import 'features/debug/debug_error_overlay.dart';
import 'services/providers.dart';
import 'services/stats_service.dart';
import 'ui/app_widgets.dart';

/// 全局根导航 key：切后台补锁屏覆盖路由用。
final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>();

class PicWallApp extends ConsumerWidget {
  const PicWallApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(settingsControllerProvider).settings.themeMode;
    return MaterialApp(
      title: 'PicWall',
      debugShowCheckedModeBanner: false,
      navigatorKey: rootNavigatorKey,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: switch (mode) {
        'system' => ThemeMode.system,
        'light' => ThemeMode.light,
        _ => ThemeMode.dark,
      },
      builder: (context, child) =>
          DebugErrorOverlay(child: child ?? const SizedBox()),
      home: const RootGate(),
    );
  }
}

/// 顶层路由门：应用锁(启用时) → 未配置→Onboarding；未登录→登录页；否则→Shell。
class RootGate extends ConsumerStatefulWidget {
  const RootGate({super.key});

  @override
  ConsumerState<RootGate> createState() => _RootGateState();
}

class _RootGateState extends ConsumerState<RootGate>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final settings = ref.read(settingsControllerProvider);
      if (!settings.loaded) {
        settings.load().then((_) => _initStats());
      } else {
        _initStats();
      }
      ref.read(sessionControllerProvider).restore();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    StatsService.instance.stop();
    super.dispose();
  }

  void _initStats() {
    final s = ref.read(settingsControllerProvider).settings;
    if (s.apiBase.isNotEmpty) {
      StatsService.instance.init(apiBase: s.apiBase);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) {
      _armLock();
    }
  }

  /// 切后台：若应用锁开启且当前未锁，复位解锁态并保证屏幕被锁屏覆盖
  /// （避免任务切换快照泄露上方内容，也防止直接返回前台时内容可见）。
  Future<void> _armLock() async {
    final settingsCtl = ref.read(settingsControllerProvider);
    final lockCtl = ref.read(appLockControllerProvider);
    if (!settingsCtl.loaded) return;
    if (!settingsCtl.settings.lockEnabled || !lockCtl.unlocked) return;
    lockCtl.lock();
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted) return;
    final nav = rootNavigatorKey.currentState;
    if (nav == null || !nav.canPop()) return;
    await nav.push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const LockScreen(allowPop: true),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final settingsState = ref.watch(settingsControllerProvider);
    final lockCtl = ref.watch(appLockControllerProvider);
    final sessionState = ref.watch(sessionControllerProvider);

    // 配置尚未恢复完成
    if (!settingsState.loaded && settingsState.error == null) {
      return const _Splash();
    }

    final locked =
        settingsState.settings.lockEnabled && !lockCtl.unlocked;

    final session = sessionState.session;
    final Widget body;
    if (!settingsState.settings.onboarded) {
      body = const OnboardingPage();
    } else if (session == null || !session.loggedIn) {
      body = const LoginPage();
    } else {
      body = const HomeShell();
    }
    if (locked) {
      return const LockScreen();
    }
    return body;
  }
}

class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    const pages = <Widget>[
      DiscoverPage(),
      GalleryPage(),
      MyPage(),
    ];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.explore_outlined), label: '发现'),
          NavigationDestination(icon: Icon(Icons.photo_library_outlined), label: '图库'),
          NavigationDestination(icon: Icon(Icons.person_outline), label: '我的'),
        ],
      ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: AppLoadingIndicator(),
    );
  }
}
