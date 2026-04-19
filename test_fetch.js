async function test() {
  try {
    const res = await fetch("http://localhost:3000/");
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body length:", text.length);
    console.log("Body start:", text.substring(0, 100));
  } catch (e) {
    console.error("Fetch error:", e);
  }
}
test();
