import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;

interface PackageManifest {
	name: string;
	version: string;
	license: string;
	keywords: string[];
	files: string[];
	pi?: { extensions?: string[] };
	peerDependencies?: Record<string, string>;
	publishConfig?: { access?: string };
	repository?: { url?: string };
}

function readPackage(): PackageManifest {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;
}

describe("Pi package manifest", () => {
	test("declares a public Pi extension package", () => {
		const pkg = readPackage();
		expect(pkg.name).toBe("@sanif/pi-new-api");
		expect(pkg.version).toBe("0.1.0");
		expect(pkg.license).toBe("MIT");
		expect(pkg.keywords).toContain("pi-package");
		expect(pkg.pi?.extensions).toEqual(["./index.ts"]);
		expect(pkg.peerDependencies).toEqual({ "@earendil-works/pi-coding-agent": "*" });
		expect(pkg.publishConfig?.access).toBe("public");
		expect(pkg.repository?.url).toBe("git+https://github.com/sanif/pi-new-api.git");
	});

	test("ships the runtime files and docs but no tests or fixtures", () => {
		const output = execFileSync("bun", ["pm", "pack", "--dry-run"], { cwd: root, encoding: "utf8" });
		for (const file of ["index.ts", "newapi.ts", "README.md", "CHANGELOG.md", "LICENSE", "package.json"]) {
			expect(output).toContain(file);
		}
		expect(output).not.toContain(".test.ts");
		expect(output).not.toContain("mock-server.ts");
	});
});
