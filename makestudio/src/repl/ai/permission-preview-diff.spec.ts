import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPermissionPreview } from './permission-preview';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

describe('buildPermissionPreview — real diff simulation', () => {
  describe('Edit', () => {
    it('renders a unified diff against on-disk content', () => {
      const tmp = mktmp('preview-edit');
      const fp = path.join(tmp, 'a.ts');
      fs.writeFileSync(fp, 'line one\nline two\nline three\n', 'utf8');

      const preview = buildPermissionPreview('Edit', {
        file_path: fp,
        old_string: 'line two',
        new_string: 'LINE TWO',
      });

      expect(preview.summary).toBe(fp);
      expect(preview.diff).toBeDefined();
      expect(preview.diff).toContain('LINE TWO');
    });

    it('falls back to raw old/new block view when file does not exist', () => {
      const preview = buildPermissionPreview('Edit', {
        file_path: '/nonexistent/path/x.ts',
        old_string: 'foo',
        new_string: 'bar',
      });
      expect(preview.diff).toContain('- foo');
      expect(preview.diff).toContain('+ bar');
    });

    it('surfaces an explicit error when old_string would not match', () => {
      const tmp = mktmp('preview-edit-fail');
      const fp = path.join(tmp, 'b.ts');
      fs.writeFileSync(fp, 'something else\n', 'utf8');

      const preview = buildPermissionPreview('Edit', {
        file_path: fp,
        old_string: 'NOT HERE',
        new_string: 'replaced',
      });
      expect(preview.diff).toMatch(/edit will fail/);
    });
  });

  describe('MultiEdit', () => {
    it('aggregates all edits into a single diff', () => {
      const tmp = mktmp('preview-multi');
      const fp = path.join(tmp, 'multi.ts');
      fs.writeFileSync(fp, 'A\nB\nC\nD\n', 'utf8');

      const preview = buildPermissionPreview('MultiEdit', {
        file_path: fp,
        edits: [
          { old_string: 'A', new_string: 'A1' },
          { old_string: 'C', new_string: 'C1' },
        ],
      });
      expect(preview.summary).toContain('2 edits');
      expect(preview.diff).toBeDefined();
      // Both replacements should appear in the diff.
      expect(preview.diff).toContain('A1');
      expect(preview.diff).toContain('C1');
    });

    it('reports which edit fails when the old_string does not match', () => {
      const tmp = mktmp('preview-multi-fail');
      const fp = path.join(tmp, 'mfail.ts');
      fs.writeFileSync(fp, 'A\nB\n', 'utf8');

      const preview = buildPermissionPreview('MultiEdit', {
        file_path: fp,
        edits: [
          { old_string: 'A', new_string: 'A1' },
          { old_string: 'NOPE', new_string: 'X' },
        ],
      });
      expect(preview.diff).toContain('edit 2/2 will fail');
    });
  });

  describe('Write', () => {
    it('renders diff against existing file', () => {
      const tmp = mktmp('preview-write-existing');
      const fp = path.join(tmp, 'w.ts');
      fs.writeFileSync(fp, 'old content\n', 'utf8');

      const preview = buildPermissionPreview('Write', {
        file_path: fp,
        content: 'new content\nplus more\n',
      });
      expect(preview.diff).toBeDefined();
      expect(preview.diff).toMatch(/new content|plus more/);
    });

    it('shows added-lines block for brand-new files', () => {
      const tmp = mktmp('preview-write-new');
      const fp = path.join(tmp, 'fresh.ts');
      // File does not exist yet.
      const preview = buildPermissionPreview('Write', {
        file_path: fp,
        content: 'first line\nsecond line\n',
      });
      expect(preview.diff).toBeDefined();
      // Either a unified diff against empty (with + lines) OR the
      // fallback "+ ..." block view. Both should mention the content.
      expect(preview.diff).toMatch(/first line/);
    });
  });
});
