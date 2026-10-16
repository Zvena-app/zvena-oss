package app.zvena.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** The same cases as test/links.test.mjs (the JavaScript rules this class mirrors). */
public class LinksTest {
    private static final String APP = "https://zvena.example.com";

    @Test
    public void deepLinksOpenOnTheAppOrigin() {
        assertEquals("https://zvena.example.com/docs?ws=abc#Plan-1", Links.resolve("zvena://docs?ws=abc#Plan-1", APP));
        assertEquals("https://zvena.example.com/projects/issue/12", Links.resolve("zvena://projects/issue/12", APP));
        assertEquals("https://zvena.example.com/inbox", Links.resolve("zvena:///inbox", APP));
        assertEquals("https://zvena.example.com/clip?url=https%3A%2F%2Fexample.com&title=Hi", Links.resolve("zvena://clip?url=https%3A%2F%2Fexample.com&title=Hi", APP));
    }

    @Test
    public void openTakesOnlyTheAppOrigin() {
        assertEquals("https://zvena.example.com/docs#x", Links.resolve("zvena://open?url=https%3A%2F%2Fzvena.example.com%2Fdocs%23x", APP));
        assertNull(Links.resolve("zvena://open?url=https%3A%2F%2Fevil.example%2Fdocs", APP));
        assertNull(Links.resolve("zvena://open?url=https%3A%2F%2Fzvena.example.com.evil.example%2F", APP));
        assertNull(Links.resolve("zvena://open?url=https%3A%2F%2Fuser%3Apw%40zvena.example.com%2F", APP));
        assertNull(Links.resolve("zvena://open?url=javascript%3Aalert(1)", APP));
        assertEquals("https://zvena.example.com/", Links.resolve("zvena://open", APP));
    }

    @Test
    public void neverLeavesTheOrigin() {
        assertNull(Links.resolve("zvena://%2F%2Fevil.example/x", APP));
        assertNull(Links.resolve("zvena://docs\\..\\@evil.example", APP));
        assertNull(Links.resolve("zvena://@evil.example/", APP));
        assertNull(Links.resolve("other://docs", APP));
        assertNull(Links.resolve("", APP));
        assertNull(Links.resolve(null, APP));
    }

    @Test
    public void universalLinksOnlyForClaimedPaths() {
        assertEquals("https://zvena.example.com/docs#Page-x", Links.resolve("https://zvena.example.com/docs#Page-x", APP));
        assertEquals("https://zvena.example.com/n/abc", Links.resolve("https://zvena.example.com/n/abc", APP));
        assertNull(Links.resolve("https://zvena.example.com/pricing", APP));
        assertNull(Links.resolve("https://zvena.example.com/docsx", APP));
        assertNull(Links.resolve("https://other.example/docs", APP));
        assertNull(Links.resolve("http://zvena.example.com/docs", APP));
    }

    @Test
    public void sharedTextGoesToSaveToZvena() {
        assertEquals("https://example.com/a?b=1", Links.firstUrl("Look: https://example.com/a?b=1)."));
        assertEquals("https://zvena.example.com/clip?url=https%3A%2F%2Fexample.com%2Fpost&title=Post&text=Great+read", Links.clipUrl("Great read https://example.com/post", "Post", APP));
        assertEquals("https://zvena.example.com/clip?text=just+a+note", Links.clipUrl("just a note", null, APP));
        assertEquals("https://zvena.example.com/clip", Links.clipUrl(null, null, APP));
    }
}
