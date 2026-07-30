import { describe, expect, test } from "bun:test";
import { splitDiffByFile } from "./diffModel";

// Shapes are real `git diff HEAD` output (verified against git).
const TWO_FILES = `diff --git a/server/app.ts b/server/app.ts
index 1a2b3c4..5d6e7f8 100644
--- a/server/app.ts
+++ b/server/app.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
diff --git a/web/main.tsx b/web/main.tsx
index aaa..bbb 100644
--- a/web/main.tsx
+++ b/web/main.tsx
@@ -10,2 +10,1 @@
-old line
`;

describe("splitDiffByFile — per-file review sections", () => {
  test("splits a multi-file diff and counts +/- per file", () => {
    const files = splitDiffByFile(TWO_FILES);
    expect(files.map((f) => f.path)).toEqual(["server/app.ts", "web/main.tsx"]);
    expect(files[0].status).toBe("modified");
    expect(files[0].added).toBe(2); // y=3 and z=4
    expect(files[0].removed).toBe(1); // y=2
    expect(files[1].added).toBe(0);
    expect(files[1].removed).toBe(1);
  });

  test("the +++/--- file markers are NOT counted as body add/remove", () => {
    const files = splitDiffByFile(TWO_FILES);
    // server/app.ts has one +++ and one --- marker; neither inflates the counts
    expect(files[0].added).toBe(2);
    expect(files[0].removed).toBe(1);
  });

  test("a new file is tagged added with its path from the +++ side", () => {
    const NEW = `diff --git a/web/lib/new.ts b/web/lib/new.ts
new file mode 100644
index 000..abc
--- /dev/null
+++ b/web/lib/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;
    const [f] = splitDiffByFile(NEW);
    expect(f.status).toBe("added");
    expect(f.path).toBe("web/lib/new.ts");
    expect(f.added).toBe(2);
    expect(f.removed).toBe(0);
  });

  test("a deletion is tagged deleted with its path from the --- side", () => {
    const DEL = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc..000
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`;
    const [f] = splitDiffByFile(DEL);
    expect(f.status).toBe("deleted");
    expect(f.path).toBe("old.ts");
    expect(f.removed).toBe(1);
  });

  test("a rename shows old → new in the label", () => {
    const REN = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
`;
    const [f] = splitDiffByFile(REN);
    expect(f.status).toBe("renamed");
    expect(f.label).toBe("src/old-name.ts → src/new-name.ts");
    expect(f.path).toBe("src/new-name.ts");
  });

  test("a binary change is tagged binary", () => {
    const BIN = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const [f] = splitDiffByFile(BIN);
    expect(f.status).toBe("binary");
    expect(f.added).toBe(0);
    expect(f.removed).toBe(0);
  });

  test("an empty diff yields no files", () => {
    expect(splitDiffByFile("")).toEqual([]);
    expect(splitDiffByFile("   \n  ")).toEqual([]);
  });

  test("a truncated tail (byte cap cut mid-hunk) still parses the files seen so far", () => {
    const cut = TWO_FILES.slice(0, TWO_FILES.indexOf("web/main.tsx") + 30);
    const files = splitDiffByFile(cut);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0].path).toBe("server/app.ts");
  });
});
