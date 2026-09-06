import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/providers.dart';
import 'session_controller.dart';

/// 登录 / 注册 / 兑换。
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  bool _isLogin = true;
  bool _obscure = true;
  bool _remember = true;

  final _username = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();
  final _redeem = TextEditingController();

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _code.dispose();
    _redeem.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    if (!_formKey.currentState!.validate()) return;
    final sessionCtl = ref.read(sessionControllerProvider);
    final username = _username.text.trim();
    final pass = _password.text;

    if (_isLogin) {
      final ok = await sessionCtl.login(
        username: username,
        keyPass: pass,
        rememberPass: _remember,
      );
      if (!ok && mounted) {
        _showError(sessionCtl.error ?? '登录失败');
      }
    } else {
      final code = _code.text.trim();
      if (code.isEmpty) {
        _showError('请填写兑换码');
        return;
      }
      final ok = await sessionCtl.register(
        username: username,
        password: pass,
        redeemCode: code,
        rememberPass: _remember,
      );
      if (!ok && mounted) _showError(sessionCtl.error ?? '注册失败');
    }
  }

  Future<void> _redeem() async {
    final code = _redeem.text.trim();
    if (code.isEmpty) {
      _showError('请输入兑换码');
      return;
    }
    final err = await ref.read(sessionControllerProvider).redeem(code);
    if (mounted) {
      if (err == null) {
        _redeem.clear();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('兑换成功，已更新账号级别/到期时间')),
        );
      } else {
        _showError(err);
      }
    }
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg), backgroundColor: Theme.of(context).colorScheme.error));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final sessionCtl = ref.watch(sessionControllerProvider);
    final busy = sessionCtl.busy;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.lock_outline, size: 56, color: scheme.primary),
                  const SizedBox(height: 10),
                  Text(
                    '登录 PicWall',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 22),
                  SegmentedButton<bool>(
                    segments: const [
                      ButtonSegment(value: true, label: Text('登录')),
                      ButtonSegment(value: false, label: Text('注册')),
                    ],
                    selected: {_isLogin},
                    onSelectionChanged: busy
                        ? null
                        : (s) => setState(() => _isLogin = s.first),
                  ),
                  const SizedBox(height: 18),
                  Form(
                    key: _formKey,
                    child: Column(
                      children: [
                        TextFormField(
                          controller: _username,
                          decoration: const InputDecoration(
                            labelText: '用户名',
                            prefixIcon: Icon(Icons.person_outline),
                          ),
                          textInputAction: TextInputAction.next,
                          validator: (v) =>
                              (v == null || v.trim().isEmpty) ? '请输入用户名' : null,
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _password,
                          obscureText: _obscure,
                          decoration: InputDecoration(
                            labelText: _isLogin ? '密钥密码' : '设置密码（至少 6 位）',
                            prefixIcon: const Icon(Icons.key_outlined),
                            suffixIcon: IconButton(
                              icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                              onPressed: () => setState(() => _obscure = !_obscure),
                            ),
                          ),
                          onFieldSubmitted: (_) => _submit(),
                          validator: (v) {
                            if (v == null || v.isEmpty) return '请输入密码';
                            if (!_isLogin && v.length < 6) return '密码至少 6 位';
                            return null;
                          },
                        ),
                        if (!_isLogin) ...[
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: _code,
                            decoration: const InputDecoration(
                              labelText: '兑换码',
                              hintText: '注册码',
                              prefixIcon: Icon(Icons.redeem),
                            ),
                            textCapitalization: TextCapitalization.characters,
                          ),
                        ],
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Checkbox(
                              value: _remember,
                              onChanged: (v) => setState(() => _remember = v ?? true),
                            ),
                            const Text('记住我（本地保存口令）'),
                          ],
                        ),
                        const SizedBox(height: 8),
                        FilledButton(
                          onPressed: busy ? null : _submit,
                          child: busy
                              ? const SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                )
                              : Text(_isLogin ? '登录' : '注册并登录'),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  // 兑换（登录后使用；未登录也可通过页面底部入口发起）
                  if (ref.read(sessionControllerProvider).session != null)
                    ExpansionTile(
                      title: const Text('兑换升级 / 续期码'),
                      leading: const Icon(Icons.card_giftcard),
                      tilePadding: EdgeInsets.zero,
                      childrenPadding: const EdgeInsets.only(bottom: 8),
                      shape: const Border(),
                      collapsedShape: const Border(),
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _redeem,
                                decoration: const InputDecoration(
                                  hintText: '输入兑换码',
                                  prefixIcon: Icon(Icons.redeem),
                                ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            OutlinedButton(
                              onPressed: busy ? null : _redeem,
                              child: const Text('兑换'),
                            ),
                          ],
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
