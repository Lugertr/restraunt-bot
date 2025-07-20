export const enum Step {
    Preview = 0,
    Department,
    Dates,
    Stars,
    //Restaurant,
    PageSize,
    GetData
}

export type Filters = {
    department_ids: string[];
    restaurant_id?: string;
    created_at_after?: string;
    created_at_before?: string;
    stars?: string;
    page_size: string;
    lastChecked: string;
};

export type Department = { id: string; name: string };
export type Comment = {
    id: number;
    text: string;
    created_at: string;
    name: string;
    profile_url: string | null;
    stars: number;
    restaurant: Restaurant;
};
export type CommentContainer = {
    count: number;
    next: string;
    previous: string;
    results: Comment[];
};

export interface Restaurant {
    id: number;
    restaurant_id: string;
    type_comments_loader: string; 
    department: string;
    rating: number;
    name: string;
    review_url: string;
}