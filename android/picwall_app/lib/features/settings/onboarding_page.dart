import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/api_client.dart';
import '../../services/providers.dart';
import '../../services/settings.dart';
import '../../services/update_service.dart';

/// 首次启动引导：确认服务器地址。
class OnboardingPage extends ConsumerStatefulWidget {
  const OnboardingPage({super.key});

  @override
  ConsumerState<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends ConsumerState<OnboardingPage> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _apiBase;
  late final TextEditingController _cdnBase;
  bool _checking = false;
  String? _checkResult;

  @override
  void initState() {
    super.initState();
    final s = ref.read(settingsControllerProvider).settings;
    _apiBase = TextEditingController(text: s.apiBase);
    _cdnBase = TextEditingController(text: s.cdnBase);
  }
  @override
  void dispose() {
    _apiBase.dispose();
    _cdnBase.dispose();
    super.dispose();
  }

  Future<void> _checkHealth() async {
    FocusScope.of(context).unfocus();
    final apiBase = _apiBase.text.trim();
    if (apiBase.isEmpty) {
      setState(() => _checkResult = '请输入 API 服务器地址');
      return;
    }
    setState(() {
      _checking = true;
      _checkResult = null;
    });
    try {
      // 用「输入框中的地址」临时探测，而非已保存的旧地址
      final host = SettingsController.normalizeHost(apiBase);
      final client = ApiClient(baseUrl: host);
      final resp = await client.getRaw('/health', noKey: true);
      final ok = resp['ok'] == true || resp['status'] != null;
      if (mounted) {
        setState(() {
          _checking = false;
          _checkResult = ok ? '连接成功 ✓ 服务器可达' : '服务器可达（未返回标准 /health）';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _checking = false;
          _checkResult = '连接失败：请检查地址与网络';
        });
      }
    }
  }

  Future<void> _save() async {
    FocusScope.of(context).unfocus();
    if (!_formKey.currentState!.validate()) return;
    await ref.read(settingsControllerProvider).save(
          apiBase: _apiBase.text,
          cdnBase: _cdnBase.text,
          onboarded: true,
        );
    // 让更新检查在当次会话内就指向新服务器，避免重启前仍探测默认域
    UpdateService.instance.updateConfig(apiBase: _apiBase.text);
    // 保存后由 RootGate 依据 onboarded 状态切换到登录页
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(Icons.photo_library, size: 64, color: scheme.primary),
                    const SizedBox(height: 12),
                    Text(
                      'PicWall 图墙',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '首次使用，请确认你的服务器地址',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 28),
                    TextFormField(
                      controller: _apiBase,
                      decoration: const InputDecoration(
                        labelText: 'API 服务器',
                        hintText: 'https://telegram-r2-bot.wo58.cn',
                        prefixIcon: Icon(Icons.dns_outlined),
                      ),
                      keyboardType: TextInputType.url,
                      validator: (v) {
                        if (v == null || v.trim().isEmpty) return '请输入 API 服务器';
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _cdnBase,
                      decoration: const InputDecoration(
                        labelText: '静态直链域名（可选）',
                        hintText: 'https://telegramup.wo58.cn',
                        prefixIcon: Icon(Icons.link),
                      ),
                      keyboardType: TextInputType.url,
                    ),
                    const SizedBox(height: 18),
                    if (_checkResult != null) ...[
                      Text(
                        _checkResult!,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: _checkResult!.startsWith('连接成功') ||
                                  _checkResult!.startsWith('服务器可达')
                              ? const Color(0xFF4CAF50)
                              : scheme.error,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _checking ? null : _checkHealth,
                            icon: _checking
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  )
                                : const Icon(Icons.wifi_tethering),
                            label: const Text('检测连接'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: FilledButton(
                            onPressed: _save,
                            child: const Text('保存并继续'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
