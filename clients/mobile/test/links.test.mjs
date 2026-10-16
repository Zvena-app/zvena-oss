import { test } from "node:test";
import assert from "node:assert/strict";
import links from "../src/links.js";

const APP = "https://zvena.app";
const { resolveLink, clipUrl, firstUrl } = links;

test("zvena:// paths open on the app origin", () => {
  assert.equal(resolveLink("zvena://docs?ws=abc#Plan-0123456789abcdef0123456789abcdef", APP), "https://zvena.app/docs?ws=abc#Plan-0123456789abcdef0123456789abcdef");
  assert.equal(resolveLink("zvena://projects/issue/12", APP), "https://zvena.app/projects/issue/12");
  assert.equal(resolveLink("zvena:///inbox", APP), "https://zvena.app/inbox");
  assert.equal(resolveLink("zvena://clip?url=https%3A%2F%2Fexample.com&title=Hi", APP), "https://zvena.app/clip?url=https%3A%2F%2Fexample.com&title=Hi");
});

test("zvena://open takes only URLs of the app origin", () => {
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://zvena.app/docs#x")}`, APP), "https://zvena.app/docs#x");
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://evil.example/docs")}`, APP), null);
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://zvena.app.evil.example/")}`, APP), null);
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://user:pw@zvena.app/")}`, APP), null);
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("javascript:alert(1)")}`, APP), null);
  assert.equal(resolveLink("zvena://open", APP), "https://zvena.app/");
});

test("zvena:// never leaves the origin", () => {
  assert.equal(resolveLink("zvena://%2F%2Fevil.example/x", APP), null);
  assert.equal(resolveLink("zvena://docs\\..\\@evil.example", APP), null);
  assert.equal(resolveLink("zvena://@evil.example/", APP), null);
  assert.equal(resolveLink("other://docs", APP), null);
  assert.equal(resolveLink("", APP), null);
  assert.equal(resolveLink("zvena://" + "a".repeat(9000), APP), null);
});

test("universal links: only the claimed paths of the app origin", () => {
  assert.equal(resolveLink("https://zvena.app/docs#Page-x", APP), "https://zvena.app/docs#Page-x");
  assert.equal(resolveLink("https://zvena.app/n/abc", APP), "https://zvena.app/n/abc");
  assert.equal(resolveLink("https://zvena.app/join/tok", APP), "https://zvena.app/join/tok");
  assert.equal(resolveLink("https://zvena.app/pricing", APP), null);
  assert.equal(resolveLink("https://zvena.app/docsx", APP), null);
  assert.equal(resolveLink("https://other.example/docs", APP), null);
  assert.equal(resolveLink("http://zvena.app/docs", APP), null);
});

test("shared text goes to the Save to zvena screen", () => {
  assert.equal(firstUrl("Look: https://example.com/a?b=1)."), "https://example.com/a?b=1");
  assert.equal(clipUrl({ text: "Great read https://example.com/post", subject: "Post" }, APP), "https://zvena.app/clip?url=https%3A%2F%2Fexample.com%2Fpost&title=Post&text=Great+read");
  assert.equal(clipUrl({ text: "just a note" }, APP), "https://zvena.app/clip?text=just+a+note");
  assert.equal(clipUrl({}, APP), "https://zvena.app/clip");
  assert.equal(clipUrl({ url: "https://example.com", text: "" }, "http://127.0.0.1:3955"), "http://127.0.0.1:3955/clip?url=https%3A%2F%2Fexample.com");
});
