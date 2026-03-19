import { Component } from "@angular/core";
import { MindmapComponent } from "./mindmap.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [MindmapComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {}
