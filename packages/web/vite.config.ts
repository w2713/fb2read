import { defineConfig } from "vite";

// Читалка живёт по отдельному адресу, а установщики остаются в корне сайта:
// ссылки на install.sh и install.ps1 зашиты в README и в уже выпущенные
// установщики, ломать их нельзя.
export default defineConfig({
  base: "/fb2read/app/",
  build: { target: "es2022", outDir: "dist" },
});
