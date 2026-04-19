import { createServer as createViteServer } from "vite";
async function main() {
  try {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    console.log("SUCCESS");
    process.exit(0);
  } catch (err) {
    console.error("FAILED Vite", err);
    process.exit(1);
  }
}
main();
