import { bootstrapApplication } from "@angular/platform-browser";
import { definePreset } from "@primeng/themes";
import Aura from "@primeng/themes/aura";
import { appConfig } from "./app/app.config";
import { AppComponent } from "./app/app.component";

definePreset(Aura);

bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err),
);
