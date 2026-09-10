import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/core/link_extract.dart';

void main() {
  group('extractFirstUrl', () {
    test('从小红书分享文案提取短链', () {
      const text = '来窗边拍个照 记得右划 健身塑造的不只是身材，更... '
          'https://xhslink.cn/o/4hQ67ZuBa9T \n这篇内容在【小红书】候着你~';
      expect(extractFirstUrl(text), 'https://xhslink.cn/o/4hQ67ZuBa9T');
    });

    test('去除链接末尾误入的英文标点', () {
      expect(extractFirstUrl('看这个 https://a.com/b). '), 'https://a.com/b');
      expect(extractFirstUrl('https://a.com/x,再点'), 'https://a.com/x');
    });

    test('保留 query 参数', () {
      expect(
        extractFirstUrl('https://a.com/p?x=1&y=2 好'),
        'https://a.com/p?x=1&y=2',
      );
    });

    test('纯链接原样返回并忽略前后空白', () {
      expect(
        extractFirstUrl('  https://example.com/a  '),
        'https://example.com/a',
      );
    });

    test('无链接返回空串', () {
      expect(extractFirstUrl(''), '');
      expect(extractFirstUrl('只有中文没有链接'), '');
    });

    test('多个链接取第一个', () {
      expect(
        extractFirstUrl('https://a.com/1 与 https://b.com/2'),
        'https://a.com/1',
      );
    });
  });
}
