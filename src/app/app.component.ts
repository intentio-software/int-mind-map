import { Component, inject, OnInit } from '@angular/core';
import { MindmapComponent } from './mindmap.component';
import { Toast } from 'primeng/toast';
import { Button } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { UpdaterService } from './services/updater.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [MindmapComponent, Toast, Button],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  protected updater = inject(UpdaterService);
  private messages = inject(MessageService);

  ngOnInit(): void {
    // Delay slightly so the app shell is fully rendered before showing a toast
    setTimeout(() => this.updater.checkForUpdates(), 3000);
  }

  installUpdate(message: any): void {
    this.updater.installUpdate(message.data);
  }
}
