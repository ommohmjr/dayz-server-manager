import { Component, Input, OnInit } from '@angular/core';
import { SBRouteData, SideNavItem } from '../../models';

@Component({
    selector: 'sb-side-nav-item',
    templateUrl: './side-nav-item.component.html',
    styleUrls: ['side-nav-item.component.scss'],
})
export class SideNavItemComponent implements OnInit {

    @Input() public sideNavItem!: SideNavItem;
    @Input() public isActive!: boolean;

    public expanded = false;
    public routeData!: SBRouteData;

    public ngOnInit(): void {
        // ignore
    }

}
