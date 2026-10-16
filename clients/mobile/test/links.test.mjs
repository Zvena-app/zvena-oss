import { test } from "node:test";
import assert from "node:assert/strict";
import links from "../src/links.js";

const APP = "https://zvena.example.com";
const { resolveLink, clipUrl, firstUrl } = links;

test("zvena:// paths open on the app origin", () => {
  assert.equal(resolveLink("zvena://docs?ws=abc#Plan-0123456789abcdef0123456789abcdef", APP), "https://zvena.example.com/docs?ws=abc#Plan-0123456789abcdef0123456789abcdef");
  assert.equal(resolveLink("zvena://projects/issue/12", APP), "https://zvena.example.com/projects/issue/12");
  assert.equal(resolveLink("zvena:///inbox", APP), "https://zvena.example.com/inbox");
  assert.equal(resolveLink("zvena://clip?url=https%3A%2F%2Fexample.com&title=Hi", APP), "https://zvena.example.com/clip?url=https%3A%2F%2Fexample.com&title=Hi");
});

test("zvena://open takes only URLs of the app origin", () => {
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://zvena.example.com/docs#x")}`, APP), "https://zvena.example.com/docs#x");
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://evil.example/docs")}`, APP), null);
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://zvena.example.com.evil.example/")}`, APP), null);
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("https://user:pw@zvena.example.com/")}`, APP), null);
  assert.equal(resolveLink(`zvena://open?url=${encodeURIComponent("javascript:alert(1)")}`, APP), null);
  assert.equal(resolveLink("zvena://open", APP), "https://zvena.example.com/");
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
  assert.equal(resolveLink("https://zvena.example.com/docs#Page-x", APP), "https://zvena.example.com/docs#Page-x");
  assert.equal(resolveLink("https://zvena.example.com/n/abc", APP), "https://zvena.example.com/n/abc");
  assert.equal(resolveLink("https://zvena.example.com/join/tok", APP), "https://zvena.example.com/join/tok");
  assert.equal(resolveLink("https://zvena.example.com/pricing", APP), null);
  assert.equal(resolveLink("https://zvena.example.com/docsx", APP), null);
  assert.equal(resolveLink("https://other.example/docs", APP), null);
  assert.equal(resolveLink("http://zvena.example.com/docs", APP), null);
});

test("shared text goes to the Save to zvena screen", () => {
  assert.equal(firstUrl("Look: https://example.com/a?b=1)."), "https://example.com/a?b=1");
  assert.equal(clipUrl({ text: "Great read https://example.com/post", subject: "Post" }, APP), "https://zvena.example.com/clip?url=https%3A%2F%2Fexample.com%2Fpost&title=Post&text=Great+read");
  assert.equal(clipUrl({ text: "just a note" }, APP), "https://zvena.example.com/clip?text=just+a+note");
  assert.equal(clipUrl({}, APP), "https://zvena.example.com/clip");
  assert.equal(clipUrl({ url: "https://example.com", text: "" }, "http://127.0.0.1:3955"), "http://127.0.0.1:3955/clip?url=https%3A%2F%2Fexample.com");
});
