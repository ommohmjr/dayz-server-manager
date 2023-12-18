import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Injectable()
export class AuthGuard  {

    public constructor(
        private auth: AuthService,
        private router: Router,
    ) {}

    public canActivate(): boolean {

        if (!this.auth.getAuth()) {
            void this.router.navigate(['/login']);
            return false;
        }

        return true;
    }

    public canActivateChild(): boolean {
        return this.canActivate();
    }

}

@Injectable()
export class LoginGuard  {

    public constructor(
        private auth: AuthService,
        private router: Router,
    ) {}

    public canActivate(): boolean {

        if (!!this.auth.getAuth()) {
            void this.router.navigate(['dashboard']);
            return false;
        }

        return true;
    }

    public canActivateChild(): boolean {
        return this.canActivate();
    }

}
