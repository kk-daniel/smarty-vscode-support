import { FormattingOptions } from 'vscode';
import { FormattingLiterals, FormattingTags } from "../interfaces";
import { CONFIG } from "../configuration";

const beautify = require("../js-beautify").html;

export class BeautifySmarty {

	private literals: FormattingLiterals = {
		strings: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/,
		smartyComment: /{\*[\s\S]*?\*}/,
		htmlComment: /<!--[\s\S]*?-->/,
		cssComment: /\/\*[\s\S]*?\*\//,
		scriptTemplate: /<script .*?type=['"]text\/template['"].*?>[\s\S]*?<\/script>/
	};

	private tags: FormattingTags = {
		start: new Set(["block", "capture", "for", "foreach", "function", "if", "literal", "section", "setfilter", "strip", "while"]),
		middle: new Set(["else", "elseif", "foreachelse"]),
		end: new Set(["block", "capture", "for", "foreach", "function", "if", "literal", "section", "setfilter", "strip", "while"])
	};

	public beautify(docText: String, options: FormattingOptions): string {
		const embeddedRegExp: RegExp = /(<(?:script|style)[\s\S]*?>)([\s\S]*?)(<\/(?:script|style)>)/g;
		const smartyRegExp: RegExp = /({{?[^}\n\s][^}]+}?)/gm;

		// escape smarty literals in script and style
		let isEscaped: boolean = false;
		docText = docText.replace(embeddedRegExp, (match, start, content, end) => {
			if (!content.trim()) {
				return match;
			}
			isEscaped = true;
			//return start + content.replace(smartyRegExp, "/* beautify ignore:start */$1/* beautify ignore:end */") + end;
			return start + content.replace(smartyRegExp, (match) => {
				var key = Buffer.from(match).toString('hex');
				if(start.indexOf("<style") === 0) {
					return `/*SMARTY_CODE_${key}_SMARTY_CODE*/`;
				}
				else {
					return `SMARTY_CODE_${key}_SMARTY_CODE`;
				}
			}) + end;
		});

		// format using js-beautify
		const beautifyConfig = this.beautifyConfig(options);
		let formatted = beautify(docText, beautifyConfig);

		// unescape smarty literals in script and style
		if (isEscaped) {
			formatted = formatted.replace(embeddedRegExp, (match, start, content, end) => {
				var re: RegExp = start.indexOf("<style") === 0 ? /\/\*SMARTY_CODE_([a-zA-Z0-9]+)_SMARTY_CODE\*\//g : /SMARTY_CODE_([a-zA-Z0-9]+)_SMARTY_CODE/g;
				return match.replace(re, (match, key) => {
					return Buffer.from(key, "hex").toString();
				});
			});
		}

		// split into lines
		const literalPattern: string = Object.values(this.literals).map(r => r.source).join("|");
		const linkPattern: RegExp = new RegExp(`${literalPattern}|(?<linebreak>\r?\n)|(?<end>$)`, "gm");

		let start: number;
		let lines: string[] = [];
		let match: RegExpExecArray;
		while (match = linkPattern.exec(formatted)) {
			if (match.groups.linebreak !== undefined) {
				lines.push(formatted.substring(start + match.groups.linebreak.length || 0, match.index));
				start = match.index;
			} else if (match.groups.end !== undefined) {
				lines.push(formatted.substring(start, formatted.length).trimLeft());
				break;
			}
		}

		const indent_char = beautifyConfig.indent_with_tabs ? "\t" : " ".repeat(beautifyConfig.indent_size);
		const region = /({{?)(\/?)(\w+)/g;

		const startedRegions = [];
		const openTags = [];
		let i = 0;

		while (i < lines.length) {
			let line = lines[i];

			// detect smarty tags
			let repeat = startedRegions.length;

			let startMatch = [];
			let middleMatch = [];
			let endMatch = [];

			let lastMatch = 0;

			let openTagsIndent = 0;
			for(let openTag of openTags) {
				if(!this.tags.start.has(openTag[3])) {
					openTagsIndent++;
				}
			}

			let match: RegExpExecArray;
			while (match = region.exec(line)) {
				let closeBracketIndex = line.indexOf("}", lastMatch);
				if(closeBracketIndex > -1 && closeBracketIndex < match.index) {
					openTags.pop();
				}

				lastMatch = match.index;
				let [fullmatch, openBracket, close, tag] = match;

				if (!close && this.tags.start.has(tag)) {
					startMatch.push(fullmatch, tag);
				} else if (!close && this.tags.middle.has(tag)) {
					middleMatch.push(fullmatch, tag);
				} else if (close && this.tags.end.has(tag)) {
					endMatch.push(fullmatch, tag);
				}

				openTags.push(match);
			}

			let closeBracketIndex;
			const beginsWithCloseBracket = openTags.length > 0 && line.replace(/^[ \t]+/, "").charAt(0) == "}";
			while(openTags.length > 0 && (closeBracketIndex = line.indexOf("}", lastMatch)) > -1) {
				openTags.pop();
				lastMatch = closeBracketIndex+1;
			}

			if (startMatch.length) {
				startedRegions.push(startMatch[0]);
			} else if (middleMatch.length) {
				repeat--;
			} else if (endMatch.length) {
				startedRegions.pop();
				repeat--;
			}

			// indent smarty block
			if (startMatch[1] && (startMatch[1] == endMatch[1])) {
				startedRegions.pop();
			} else if ((startMatch.length + middleMatch.length + endMatch.length) > 2) {
				let iter = 0;

				const spaces = line.replace(/^([ \t]+).*/s, "$1");
				const newLines = line.replace(region, (match: string) => (iter++ ? "\n" + spaces : "") + match).split("\n");
				lines.splice(i, 1, ...newLines);
			}

			if(openTags.length > 0) {
				lines[i] = indent_char.repeat(Math.max(0, repeat+openTagsIndent)) + lines[i].replace(/^[ \t]+/, "");
			}
			else if(beginsWithCloseBracket) {
				lines[i] = indent_char.repeat(Math.max(0, repeat-1+openTagsIndent)) + lines[i].replace(/^[ \t]+/, "");
			}
			else {
				lines[i] = indent_char.repeat(Math.max(0, repeat)) + lines[i];
			}
			i += 1;
		}

		formatted = lines.join("\n").replace(/^[ \t]+$/gm, "");

		return formatted;
	}

	private beautifyConfig(options: FormattingOptions) {
		const config = {
			indent_size: options.tabSize,
			indent_with_tabs: !options.insertSpaces,
			indent_handlebars: false,
			indent_inner_html: CONFIG.indentInnerHtml,
			max_preserve_newlines: CONFIG.maxPreserveNewLines,
			preserve_newlines: CONFIG.preserveNewLines,
			wrap_line_length: CONFIG.wrapLineLength,
			wrap_attributes: CONFIG.wrapAttributes,
			brace_style: "collapse,preserve-inline",
			jslint_happy: false,
			indent_empty_lines: true,
			html: {
				end_with_newline: CONFIG.endWithNewline,
				js: { end_with_newline: false },
				css: { end_with_newline: false },
			},
			templating: ["smarty"]
		};

		return config;
	}

}