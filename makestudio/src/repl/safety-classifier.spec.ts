import { classifyCommand } from './safety-classifier';

describe('safety-classifier', () => {
  describe('in-place regex mutation guard — language-agnostic', () => {
    // The risk being defended against (multi-line corruption of structured
    // source) applies to ANY language: TS imports, Python imports, Rust
    // use blocks, Java annotations, YAML/TOML configs, etc. So `sed -i`
    // and friends are blocked unconditionally — the agent has Edit/MultiEdit
    // for surgical changes.

    it('blocks sed -i regardless of file extension', () => {
      const cases = [
        "sed -i 's/foo/bar/g' src/App.ts",       // TypeScript
        "sed -i '5d' /home/u/proj/Foo.tsx",       // TSX
        'sed -i.bak "s/x/y/" Comp.jsx',           // JSX
        "sed -i 's/x/y/' src/main.py",            // Python
        "sed -i 's/x/y/' src/lib.rs",             // Rust
        "sed -i 's/x/y/' src/main.go",            // Go
        'sed -i "s/x/y/" lib/App.dart',           // Flutter/Dart
        "sed -i 's/x/y/' Main.java",              // Java
        "sed -i 's/x/y/' app.rb",                 // Ruby
        "sed -i 's/x/y/' README.md",              // Markdown
        "sed -i 's/x/y/' package.json",           // JSON
      ];
      for (const cmd of cases) {
        const v = classifyCommand(cmd);
        expect(v.blocked).toBe(true);
        expect(v.matchedRule).toBe('sed -i');
        expect(v.reason).toMatch(/Edit\/MultiEdit/);
      }
    });

    it('does NOT block sed without -i (read-only modes)', () => {
      expect(classifyCommand("sed -n '1,10p' src/App.ts").blocked).toBe(false);
      expect(classifyCommand("sed 's/x/y/g' src/App.ts").blocked).toBe(false);
      expect(classifyCommand("sed 's/x/y/g' src/main.py").blocked).toBe(false);
    });

    it('blocks awk inplace regardless of file extension', () => {
      expect(classifyCommand('awk -i inplace "{print}" src/App.ts').blocked).toBe(true);
      expect(classifyCommand('gawk -i inplace "..." src/main.py').blocked).toBe(true);
      expect(classifyCommand('awk -i inplace "{print}" lib/main.dart').blocked).toBe(true);
      const v = classifyCommand('awk -i inplace "{print}" Foo.tsx');
      expect(v.matchedRule).toBe('awk inplace');
    });

    it('blocks python -c with re.sub regardless of target file', () => {
      // Multi-line corruption from naive regex applies to Python files too.
      const v1 = classifyCommand(
        `python3 -c "import re; open('src/Foo.ts','w').write(re.sub('a','b', open('src/Foo.ts').read()))"`,
      );
      expect(v1.blocked).toBe(true);
      expect(v1.matchedRule).toBe('inline regex');

      const v2 = classifyCommand(
        `python3 -c "import re; open('mod.py','w').write(re.sub('a','b', open('mod.py').read()))"`,
      );
      expect(v2.blocked).toBe(true);

      const v3 = classifyCommand(
        `python3 -c "import re; open('app.dart','w').write(re.sub('a','b', open('app.dart').read()))"`,
      );
      expect(v3.blocked).toBe(true);
    });

    it('blocks perl -e s/// regardless of target file', () => {
      expect(classifyCommand(`perl -e "s/foo/bar/g" src/App.tsx`).blocked).toBe(true);
      expect(classifyCommand(`perl -e "s/foo/bar/g" src/main.py`).blocked).toBe(true);
      expect(classifyCommand(`perl -e "s/foo/bar/g" src/main.rs`).blocked).toBe(true);
    });

    it('does NOT block python -c without regex-mutation API', () => {
      // python -c by itself is requiresApproval (handled by inline-eval
      // patterns elsewhere in the classifier), not a hard block.
      const v = classifyCommand('python3 -c "print(1+1)"');
      expect(v.blocked).toBe(false);
      expect(v.requiresApproval).toBe(true);
    });
  });

  describe('git checkout/restore panic-restore guard (fix #4)', () => {
    it('flags `git checkout HEAD -- file.ts` as requiresApproval', () => {
      const v = classifyCommand('git checkout HEAD -- src/App.ts');
      expect(v.blocked).toBe(false);
      expect(v.requiresApproval).toBe(true);
      expect(v.matchedRule).toBe('git checkout --');
      expect(v.reason).toMatch(/wipes uncommitted/);
    });

    it('flags `git checkout -- file.ts` (without HEAD) as requiresApproval', () => {
      const v = classifyCommand('git checkout -- src/Foo.tsx');
      expect(v.blocked).toBe(false);
      expect(v.requiresApproval).toBe(true);
    });

    it('flags `git restore <file>` as requiresApproval', () => {
      const v = classifyCommand('git restore src/App.ts');
      expect(v.requiresApproval).toBe(true);
      expect(v.matchedRule).toBe('git restore');
    });

    it('flags `git restore --staged <file>` as requiresApproval too', () => {
      // --staged is less destructive (just unstages) but still resets
      // tracked working state for caller's perspective; safer to gate.
      expect(classifyCommand('git restore --staged src/App.ts').requiresApproval).toBe(true);
    });

    it('does NOT flag `git checkout <branch>` (branch switch, no --)', () => {
      expect(classifyCommand('git checkout develop').blocked).toBe(false);
      expect(classifyCommand('git checkout develop').requiresApproval).toBeFalsy();
      expect(classifyCommand('git checkout -b feature/x').requiresApproval).toBeFalsy();
    });

    it('does NOT flag `git checkout` (status query, no args)', () => {
      expect(classifyCommand('git status').requiresApproval).toBeFalsy();
    });
  });

  describe('preserves existing rules after the new checks (regression)', () => {
    it('still blocks sudo', () => {
      expect(classifyCommand('sudo apt update').blocked).toBe(true);
    });
    it('still blocks rm -rf /', () => {
      expect(classifyCommand('rm -rf /').blocked).toBe(true);
    });
    it('still blocks docker prune', () => {
      expect(classifyCommand('docker system prune -af').blocked).toBe(true);
    });
    it('still blocks "Claude" in commit messages', () => {
      expect(classifyCommand('git commit -m "Co-Authored-By: Claude"').blocked).toBe(true);
    });
    it('still flags python -c (no .ts) as requiresApproval', () => {
      const v = classifyCommand('python3 -c "print(1)"');
      expect(v.blocked).toBe(false);
      expect(v.requiresApproval).toBe(true);
    });
  });
});
