import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme.dart';
import 'features/auth/session_controller.dart';
import 'features/auth/login_page.dart';
import 'features/gallery/gallery_page.dart';
import 'features/my/my_page.dart';
import 'features/discover/discover_page.dart';
import 'features/settings/onboarding_page.dart';
import 'services/providers.dart';

class PicWallApp extends ConsumerWidget {
  const PicWallApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'PicWall',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.dark,
      home: const RootGate(),
    );
  }
}

/// 顶层路由门：未配置→Onboarding；未登录→登录页；否则→Shell。
class RootGate extends ConsumerStatefulWidget {
  const RootGate({super.key});

  @override
  ConsumerState<RootGate> createState() => _RootGateState();
}

class _RootGateState extends ConsumerState<RootGate> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final settings = ref.read(settingsControllerProvider);
      if (!settings.loaded) settings.load();
      ref.read(sessionControllerProvider).restore();
    });
  }

  @override
  Widget build(BuildContext context) {
    final settingsState = ref.watch(settingsControllerProvider);
    final sessionState = ref.watch(sessionControllerProvider);

    // 配置尚未恢复完成
    if (!settingsState.loaded && settingsState.error == null) {
      return const _Splash();
    }

    final session = sessionState.session;

    if (!settingsState.settings.onboarded) {
      return const OnboardingPage();
    }
    if (session == null || !session.loggedIn) {
      return const LoginPage();
    }
    return const HomeShell();
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
    final pages = const <Widget>[
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
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
