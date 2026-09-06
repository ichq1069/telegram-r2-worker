import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants.dart';
import '../../data/models/user.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/providers.dart';
import '../auth/login_page.dart';
import '../auth/session_controller.dart';
import '../gallery/paged_media_grid.dart';

/// 我的文件 loader：/api/v1/user/files
Future<PagedMedia> loadMyFiles(GalleryRepository repo, int page) {
  return repo.myFiles(page: page, pageSize: 20);
}

/// 我的：资料卡 + 我的图片 + 退出。
class MyPage extends ConsumerWidget {
  const MyPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessionCtl = ref.watch(sessionControllerProvider);
    final session = sessionCtl.session;
    if (session == null) return const LoginPage();
    final settings = ref.watch(settingsControllerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('我的')),
      body: ListView(
        children: [
          _ProfileCard(session: session),
          const SizedBox(height: 8),
          ListTile(
            leading: const Icon(Icons.photo_outlined),
            title: const Text('我的图片'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const PagedMediaGrid(
                    title: '我的图片',
                    loader: loadMyFiles,
                  ),
                ),
              );
            },
          ),
          ListTile(
            leading: const Icon(Icons.settings_outlined),
            title: const Text('设置'),
            subtitle: Text(
              settings.settings.apiBase,
              style: Theme.of(context).textTheme.bodySmall,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _openSettings(context, ref),
          ),
          const Divider(height: 1),
          ListTile(
            leading: const Icon(Icons.logout),
            title: const Text('退出登录'),
            onTap: () async {
              await ref.read(sessionControllerProvider).logout();
            },
          ),
        ],
      ),
    );
  }

  void _openSettings(BuildContext context, WidgetRef ref) {
    // TODO: 完整设置页见 T4.2；本轮提供退出与服务器信息占位。
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('完整设置页将在后续版本提供')),
    );
  }
}

class _ProfileCard extends StatelessWidget {
  const _ProfileCard({required this.session});

  final UserSession session;

  @override
  Widget build(BuildContext context) {
    final s = session;

    return Card(
      margin: const EdgeInsets.all(12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            CircleAvatar(
              radius: 26,
              backgroundColor: Theme.of(context).colorScheme.primary.withValues(alpha: 0.2),
              child: Text(
                s.username.isNotEmpty ? s.username[0].toUpperCase() : 'U',
                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.name.isNotEmpty ? s.name : s.username,
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      _LevelChip(level: s.level),
                      if (s.expiresAt.isNotEmpty)
                        Text(
                          '到期 ${s.expiresAt}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LevelChip extends StatelessWidget {
  const _LevelChip({required this.level});

  final UserLevel level;

  @override
  Widget build(BuildContext context) {
    final color = level == UserLevel.vvip
        ? const Color(0xFFE91E63)
        : level == UserLevel.svip
            ? const Color(0xFF7C4DFF)
            : level == UserLevel.vip
                ? const Color(0xFF29B6F6)
                : Colors.white24;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        level.label,
        style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700),
      ),
    );
  }
}
