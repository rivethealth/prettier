"use strict";

const clean = require("./clean");
const {
  builders: {
    breakParent,
    concat,
    fill,
    group,
    hardline,
    indent,
    join,
    line,
    literalline,
    markAsRoot,
    softline
  },
  utils: { removeLines, stripTrailingHardline }
} = require("../doc");
const { hasNewlineInRange } = require("../common/util");
const {
  dedentString,
  forceBreakChildren,
  forceNextEmptyLine,
  getCommentData,
  getLastDescendant,
  hasPrettierIgnore,
  inferScriptParser,
  isScriptLikeTag,
  replaceDocNewlines,
  replaceNewlines
} = require("./utils");
const preprocess = require("./preprocess");
const assert = require("assert");

function embed(path, print, textToDoc /*, options */) {
  const node = path.getValue();
  switch (node.type) {
    case "text": {
      if (isScriptLikeTag(node.parent)) {
        const parser = inferScriptParser(node.parent);
        if (parser) {
          return concat([
            breakParent,
            printOpeningTagPrefix(node),
            markAsRoot(stripTrailingHardline(textToDoc(node.data, { parser }))),
            printClosingTagSuffix(node)
          ]);
        }
      }
      break;
    }
    case "attribute": {
      /*
       * Vue binding syntax: JS expressions
       * :class="{ 'some-key': value }"
       * v-bind:id="'list-' + id"
       * v-if="foo && !bar"
       * @click="someFunction()"
       */
      if (/(^@)|(^v-)|:/.test(node.key) && !/^\w+$/.test(node.value)) {
        const doc = textToDoc(node.value, {
          parser: "__js_expression",
          // Use singleQuote since HTML attributes use double-quotes.
          // TODO(azz): We still need to do an entity escape on the attribute.
          singleQuote: true
        });
        return concat([
          node.key,
          '="',
          hasNewlineInRange(node.value, 0, node.value.length)
            ? doc
            : removeLines(doc),
          '"'
        ]);
      }
      break;
    }
    case "yaml":
      return markAsRoot(
        concat([
          "---",
          hardline,
          node.value.trim().length === 0
            ? ""
            : replaceDocNewlines(
                textToDoc(node.value, { parser: "yaml" }),
                literalline
              ),
          "---"
        ])
      );
  }
}

function genericPrint(path, options, print) {
  const node = path.getValue();
  switch (node.type) {
    case "root":
      return concat([
        group(
          concat([
            forceBreakChildren(node) ? breakParent : "",
            printChildren(path, options, print)
          ])
        ),
        hardline
      ]);
    case "tag":
    case "ieConditionalComment": {
      const doesLastChildTrailingSpaceBelongToOuterGroup = node.next
        ? needsToBorrowPrevClosingTagEndMarker(node.next)
        : needsToBorrowParentClosingTagStartMarker(node);
      const lastChildTrailingSpace =
        node.children.length === 0
          ? ""
          : node.lastChild.hasTrailingSpaces &&
            node.lastChild.isTrailingSpaceSensitive
            ? line
            : softline;
      return concat([
        group(
          concat([
            forceBreakChildren(node) ? breakParent : "",
            printOpeningTag(path, options, print),
            node.children.length === 0
              ? node.hasDanglingSpaces && node.isDanglingSpaceSensitive
                ? line
                : ""
              : concat([
                  indent(
                    concat([
                      node.firstChild.type === "text" &&
                      node.firstChild.isWhiteSpaceSensitive &&
                      node.firstChild.isIndentationSensitive
                        ? literalline
                        : node.firstChild.hasLeadingSpaces &&
                          node.firstChild.isLeadingSpaceSensitive
                          ? line
                          : softline,
                      printChildren(path, options, print)
                    ])
                  ),
                  doesLastChildTrailingSpaceBelongToOuterGroup
                    ? ""
                    : lastChildTrailingSpace
                ])
          ])
        ),
        doesLastChildTrailingSpaceBelongToOuterGroup
          ? lastChildTrailingSpace
          : "",
        group(printClosingTag(node))
      ]);
    }
    case "text":
      return concat([
        printOpeningTagPrefix(node),
        node.isWhiteSpaceSensitive
          ? node.isIndentationSensitive
            ? concat(
                replaceNewlines(
                  node.data.replace(/^\s*?\n|\n\s*?$/g, ""),
                  literalline
                )
              )
            : concat(
                replaceNewlines(
                  dedentString(node.data.replace(/^\s*?\n|\n\s*?$/g, "")),
                  hardline
                )
              )
          : fill(join(line, node.data.split(/\s+/)).parts),
        printClosingTagSuffix(node)
      ]);
    case "comment":
    case "directive": {
      const data = getCommentData(node);
      return concat([
        group(
          concat([
            printOpeningTagStart(node),
            data.trim().length === 0
              ? ""
              : concat([
                  indent(
                    concat([
                      node.prev &&
                      needsToBorrowNextOpeningTagStartMarker(node.prev)
                        ? breakParent
                        : "",
                      node.type === "directive" ? " " : line,
                      concat(replaceNewlines(data, hardline))
                    ])
                  ),
                  node.type === "directive"
                    ? ""
                    : (node.next
                      ? needsToBorrowPrevClosingTagEndMarker(node.next)
                      : needsToBorrowLastChildClosingTagEndMarker(node.parent))
                      ? " "
                      : line
                ])
          ])
        ),
        group(printClosingTagEnd(node))
      ]);
    }
    case "attribute":
      return concat([
        node.key,
        node.value === null
          ? ""
          : concat([
              '="',
              concat(
                replaceNewlines(node.value.replace(/"/g, "&quot;"), literalline)
              ),
              '"'
            ])
      ]);
    case "yaml":
    case "toml":
      return node.raw;
    default:
      throw new Error(`Unexpected node type ${node.type}`);
  }
}

function printChildren(path, options, print) {
  return concat(
    path.map((childPath, childIndex) => {
      const childNode = childPath.getValue();
      return concat([
        // line between children
        childIndex === 0 ||
        (needsToBorrowNextOpeningTagStartMarker(childNode.prev) &&
          /**
           *     123<a
           *          ~
           *       ><b>
           */
          (childNode.firstChild ||
            /**
             *     123<br />
             *            ~
             */
            (childNode.isSelfClosing && childNode.attributes.length === 0))) ||
        /**
         *     <x
         *       >123</x
         *              ~
         *     >456
         */
        (needsToBorrowPrevClosingTagEndMarker(childNode) &&
          !childNode.prev.isSelfClosing)
          ? ""
          : childNode.hasLeadingSpaces && childNode.isLeadingSpaceSensitive
            ? line
            : softline,

        // child
        print(childPath),

        // next empty line
        childNode.next &&
        (forceNextEmptyLine(childNode) ||
          childNode.endLocation.line + 1 < childNode.next.startLocation.line)
          ? hardline
          : ""
      ]);
    }, "children")
  );
}

function printOpeningTag(path, options, print) {
  const node = path.getValue();
  return concat([
    printOpeningTagStart(node),
    !node.attributes || node.attributes.length === 0
      ? node.isSelfClosing
        ? /**
           *     <br />
           *        ^
           */
          " "
        : ""
      : group(
          concat([
            node.prev && needsToBorrowNextOpeningTagStartMarker(node.prev)
              ? breakParent
              : "",
            indent(concat([line, join(line, path.map(print, "attributes"))])),
            node.firstChild &&
            needsToBorrowParentOpeningTagEndMarker(node.firstChild)
              ? /**
                 *     123<a
                 *       attr
                 *           ~
                 *       >456
                 */
                ""
              : node.isSelfClosing
                ? line
                : softline
          ])
        ),
    node.isSelfClosing ? "" : printOpeningTagEnd(node)
  ]);
}

function printOpeningTagStart(node) {
  return node.prev && needsToBorrowNextOpeningTagStartMarker(node.prev)
    ? ""
    : concat([printOpeningTagPrefix(node), printOpeningTagStartMarker(node)]);
}

function printOpeningTagEnd(node) {
  return node.firstChild &&
    needsToBorrowParentOpeningTagEndMarker(node.firstChild)
    ? ""
    : printOpeningTagEndMarker(node);
}

function printClosingTag(node) {
  return concat([
    node.isSelfClosing ? "" : printClosingTagStart(node),
    printClosingTagEnd(node)
  ]);
}

function printClosingTagStart(node) {
  return node.lastChild &&
    needsToBorrowParentClosingTagStartMarker(node.lastChild)
    ? ""
    : concat([printClosingTagPrefix(node), printClosingTagStartMarker(node)]);
}

function printClosingTagEnd(node) {
  return (node.next && needsToBorrowPrevClosingTagEndMarker(node.next)) ||
    (!node.next &&
      node.parent &&
      needsToBorrowLastChildClosingTagEndMarker(node.parent))
    ? ""
    : concat([printClosingTagEndMarker(node), printClosingTagSuffix(node)]);
}

function needsToBorrowNextOpeningTagStartMarker(node) {
  /**
   *     123<p
   *        ^^
   *     >
   */
  return (
    node.type === "text" &&
    node.isTrailingSpaceSensitive &&
    !node.hasTrailingSpaces &&
    node.next
  );
}

function needsToBorrowParentOpeningTagEndMarker(node) {
  /**
   *     <p
   *       >123
   *       ^
   *
   *     <p
   *       ><a
   *       ^
   */
  return node.isLeadingSpaceSensitive && !node.hasLeadingSpaces && !node.prev;
}

function needsToBorrowPrevClosingTagEndMarker(node) {
  /**
   *     <p></p
   *     >123
   *     ^
   *
   *     <p></p
   *     ><a
   *     ^
   */
  return node.isLeadingSpaceSensitive && !node.hasLeadingSpaces && node.prev;
}

function needsToBorrowLastChildClosingTagEndMarker(node) {
  /**
   *     <p
   *       ><a></a
   *       ></p
   *       ^
   *     >
   */
  return (
    node.lastChild &&
    node.lastChild.isTrailingSpaceSensitive &&
    !node.lastChild.hasTrailingSpaces &&
    getLastDescendant(node.lastChild).type !== "text"
  );
}

function needsToBorrowParentClosingTagStartMarker(node) {
  /**
   *     <p>
   *       123</p
   *          ^^^
   *     >
   *
   *         123</b
   *       ></a
   *        ^^^
   *     >
   */
  return (
    !node.next &&
    !node.hasTrailingSpaces &&
    node.isTrailingSpaceSensitive &&
    getLastDescendant(node).type === "text"
  );
}

function printOpeningTagPrefix(node) {
  return concat([
    needsToBorrowParentOpeningTagEndMarker(node)
      ? printOpeningTagEndMarker(node.parent)
      : needsToBorrowPrevClosingTagEndMarker(node)
        ? printClosingTagEndMarker(node.prev)
        : ""
  ]);
}

function printClosingTagPrefix(node) {
  return concat([
    needsToBorrowLastChildClosingTagEndMarker(node)
      ? printClosingTagEndMarker(node.lastChild)
      : ""
  ]);
}

function printClosingTagSuffix(node) {
  return concat([
    needsToBorrowParentClosingTagStartMarker(node)
      ? printClosingTagStartMarker(node.parent)
      : needsToBorrowNextOpeningTagStartMarker(node)
        ? printOpeningTagStartMarker(node.next)
        : ""
  ]);
}

function printOpeningTagStartMarker(node) {
  switch (node.type) {
    case "comment":
      return "<!--";
    case "ieConditionalComment":
      return `<!--[if ${node.condition}`;
    default:
      return `<${node.name}`;
  }
}

function printOpeningTagEndMarker(node) {
  assert(!node.isSelfClosing);
  switch (node.type) {
    case "ieConditionalComment":
      return "]>";
    default:
      return `>`;
  }
}

function printClosingTagStartMarker(node) {
  assert(!node.isSelfClosing);
  switch (node.type) {
    case "ieConditionalComment":
      return "<!";
    default:
      return `</${node.name}`;
  }
}

function printClosingTagEndMarker(node) {
  switch (node.type) {
    case "comment":
      return "-->";
    case "ieConditionalComment":
      return `[endif]-->`;
    case "tag":
      if (node.isSelfClosing) {
        return "/>";
      }
    // fall through
    default:
      return ">";
  }
}

module.exports = {
  preprocess,
  print: genericPrint,
  massageAstNode: clean,
  embed,
  hasPrettierIgnore
};
